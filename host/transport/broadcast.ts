// Active protocol registry — PMs survive socket disconnect (grace period for RTC fallback)
import { createLogger } from "../lib/logger.js";
import type { ProtocolManager } from "./ProtocolManager.js";

const logger = createLogger("broadcast");
const active = new Set<ProtocolManager>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVirtualHost(host: ProtocolManager["_host"]): boolean {
  return Boolean(host && "defersWsAdapter" in host && host.defersWsAdapter);
}

function hostPeerId(host: ProtocolManager["_host"]): string | undefined {
  return host && "peerId" in host && typeof host.peerId === "string" ? host.peerId : undefined;
}

export function registerProtocol(pm: ProtocolManager): void {
  active.add(pm);
  logger.debug(`register peer=${pm._deviceId?.slice(0, 12)} active=${active.size}`);
}
export function unregisterProtocol(pm: ProtocolManager): void {
  active.delete(pm);
  logger.debug(`unregister peer=${pm._deviceId?.slice(0, 12)} active=${active.size}`);
}

// Snapshot of live PMs — kick/cleanup paths sweep this by device
export function activeProtocols(): ProtocolManager[] {
  return [...active];
}

// Live carrier counts for the UI transport badges
export function getTransportStats() {
  let rtcPeers = 0, wsPeers = 0;
  for (const pm of active) {
    if (pm._adapters?.get("rtc")?.ready) rtcPeers++;
    if (pm._adapters?.get("ws")?.ready) wsPeers++;
  }
  return { rtcPeers, wsPeers };
}

// Tear down the RTC adapter on every active PM (test-toggle "disable RTC").
// Needed because after the signaling-deviceId fix, RTC lives inside the WS-hosted
// PM (real socket host), not in rtcSessions — so looping rtcSessions alone is a
// no-op. The client sees the PeerConnection close and falls back to the tunnel.
export function disableAllRtc() {
  for (const pm of active) {
    try {
      const rtc = pm._adapters?.get("rtc");
      const ws = pm._adapters?.get("ws");
      logger.debug(`disableAllRtc peer=${pm._deviceId?.slice(0, 12)} rtc=${rtc?.state || "absent"} ws=${ws?.state || "absent"} virtual=${isVirtualHost(pm._host)}`);
      if (rtc) { try { rtc.disconnect(); } catch {} pm._adapters.delete("rtc"); }
      pm._rtcSignalingHandler = null;
      // Unregister the signalingGlobal handler so new offers find no PM → flow into
      // handleRtcOffer → refused with "rtc-disabled" → client stops retrying.
      try { pm._offGlobalSig?.(); } catch {}
      pm._offGlobalSig = null;
    } catch (e) { logger.warn(`disableAllRtc failed: ${errorMessage(e)}`); }
  }
  logger.debug(`disableAllRtc: cleared RTC on ${active.size} PM(s)`);
}

// server.js registers this — broadcast must stay importable from features
// (remoteSocket) without importing server.js back (cycle).
let _rtcSessionKiller: ((peerId: string | null) => void) | null = null;
export function setRtcSessionKiller(fn: ((peerId: string | null) => void) | null): void { _rtcSessionKiller = fn; }

/** Dispose a PM AND the RTC-first session it hosts. pm.close()/unregister alone
 *  leave the HostBus's tracked entry and rtcSessions record behind — a
 *  closed browser then shows as online forever (each tab/reload = one leak). */
export function disposeProtocol(pm: ProtocolManager | null | undefined): void {
  if (!pm) return;
  try { pm.close(); } catch {}
  unregisterProtocol(pm);
  // Any PM dying means the peer's wire is down — kill its RTC session too, even
  // when this PM's host is a socket.io socket (duplicate-PM case leaves it behind).
  if (_rtcSessionKiller) _rtcSessionKiller(hostPeerId(pm._host) || pm._deviceId);
}

// Notify every active PM that RTC is enabled again (test-toggle off) — clients
// clear their stop-retry flag and renegotiate. Re-registers the signalingGlobal
// handler that disableAllRtc cleared, so the next offer finds this PM (answer)
// instead of spawning a second RTC-only PM.
export function notifyRtcEnabled() {
  for (const pm of active) {
    try {
      // Re-register the signalingGlobal handler (cleared by disableAllRtc) and
      // recreate the RTC adapter (answerer) so the client's next offer is answered
      // by this PM — otherwise signalingGlobal finds no handler and spawns a second
      // RTC-only PM (duplicate output).
      if (!pm._offGlobalSig && typeof pm.setupSignaling === "function") {
        pm.setupSignaling(pm._socket);
      }
      if (typeof pm.restartRtc === "function") pm.restartRtc();
      pm.emit("rtc:enabled", {});
      logger.debug(`notifyRtcEnabled peer=${pm._deviceId?.slice(0, 12)} re-armed RTC`);
    } catch (e) { logger.warn(`notifyRtcEnabled failed: ${errorMessage(e)}`); }
  }
  logger.debug(`notifyRtcEnabled: signaled ${active.size} PM(s)`);
}

// Duplicate output is per-frame, so warn at most once per peer-set per interval.
const DUPLICATE_WARN_INTERVAL_MS = 10_000;
let lastDuplicateKey = "";
let lastDuplicateAt = 0;

function warnDuplicate(peers: string[], targets: string[]): void {
  const key = [...peers].sort().join("|");
  const now = Date.now();
  if (key === lastDuplicateKey && now - lastDuplicateAt < DUPLICATE_WARN_INTERVAL_MS) return;
  lastDuplicateKey = key;
  lastDuplicateAt = now;
  logger.warn(`DUPLICATE: output same peer twice: ${targets.join(", ")}`);
}

// Broadcast event to active PMs (routes via best adapter — RTC if WS down).
// For "output", respects per-PM session subscriptions (wantsOutput) so inactive
// terminals don't saturate unrelated tabs/phones.
// If 2 PMs share one peerId (RTC-first HostBus + WS race) the client gets duplicate output.
export function broadcast(_io: unknown, event: string, data?: unknown): void {
  const isOutput = event === "output";
  const outputSessionId = isOutput && data !== null && typeof data === "object" && "sessionId" in data
    ? String((data as { sessionId?: unknown }).sessionId || "")
    : "";
  const peers: string[] = [];
  const targets: string[] = [];
  for (const pm of active) {
    // Skip PMs with no ready adapter — avoids buffering into dying/orphan PMs
    if (!pm.hasReadyAdapter?.()) continue;
    // Selective fan-out: only send output to peers that subscribed to this session
    // (legacy peers without subscription support keep receiving everything).
    if (isOutput && outputSessionId && !pm.wantsOutput(outputSessionId)) continue;
    peers.push(pm._deviceId || "");
    targets.push(`${pm._deviceId?.slice(0, 12)}:${pm.type}`);
    try { pm.emit(event, data); } catch (e) { logger.warn(`emit ${event} failed: ${errorMessage(e)}`); }
  }
  // Compare the FULL peerId ("deviceId:tab") — distinct tabs of one device are legit.
  if (isOutput) {
    if (new Set(peers).size !== peers.length) warnDuplicate(peers, targets);
    return;
  }
  // ai:event rides the per-chunk stream — one line per chunk buries everything else.
  if (event !== "ai:event") logger.debug(`bc ${event} → ${targets.length} target(s)`);
}
