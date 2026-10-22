import { CHANNELS, ADAPTER_STATE, RTC_HEARTBEAT_LEGACY_TIMEOUT_MS } from "@/shared/constants/transport";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";
import { probeRtcLiveness } from "./pmWatchers";
import type { ProtocolManagerContext, AckCallback, TransportChannel } from "../types";

// Control message sending, ack tracking, buffering, and inbound dispatch.

// Send control event with multi-arg and optional ack callback.
export function sendControl(pm: ProtocolManagerContext, event: string, args: unknown[]) {
  const last = args[args.length - 1];
  const cb: AckCallback | null = typeof last === "function" ? args.pop() as AckCallback : null;
  const controlChannel = CHANNELS.control as TransportChannel;
  const adapter = pm._pickAdapter(controlChannel);
  if (!adapter) {
    debugLog("transport", `[pm] buffer event=${event} (no adapter ready)`);
    termLog("switch", `buffer "${event}" (no adapter)`);
    pm._buffer.push({ event, args, cb });
    return;
  }
  const adapterId = (adapter.constructor as Function & { id: string }).id;
  debugLog("transport", `[pm] send control event=${event} via=${adapterId}`);
  if (adapterId === "rtc") {
    let ackId = null;
    if (cb) {
      ackId = `c_${++pm._ackSeq}`;
      pm._pendingAcks.set(ackId, cb);
      // Timeout detects zombie RTC and retries safe reads over WS or triggers restart.
      pm._scheduleAckTimeout(ackId, { event, args });
    }
    // If RTC send fails, retry alternative adapter or buffer for next available carrier.
    if (!adapter.send(controlChannel, { event, args, ackId })) {
      const retry = pm._pickAdapter(controlChannel);
      if (retry && retry !== adapter && retry.send(controlChannel, cb ? { event, args, ackId, cb } : { event, args, ackId })) return;
      debugLog("transport", `[pm] rtc refused event=${event} → buffered`);
      pm._buffer.push({ event, args, cb });
    }
  } else {
    adapter.send(controlChannel, { event, args, cb });
  }
}

export function flushBuffer(pm: ProtocolManagerContext) {
  if (!pm._buffer.length) return;
  const adapter = pm._pickAdapter(CHANNELS.control as TransportChannel);
  if (!adapter) return;
  // Drain buffer in one pass to prevent infinite loops on send refusals.
  const queued = pm._buffer.splice(0);
  debugLog("transport", `[pm] flush ${queued.length} buffered via=${(adapter.constructor as Function & { id: string }).id}`);
  for (const { event, args, cb } of queued) {
    pm._sendControl(event, cb ? [...args, cb] : args);
  }
}

// Dispatch incoming message from RTC or WS carrier.
export function dispatch(pm: ProtocolManagerContext, event: string, payload: unknown, source: string) {
  const message = payload as { args?: unknown[]; ackId?: string; tunnelUrl?: string; localIp?: string; status?: string } | null;
  // Cache host capabilities on PM and forward to RTC adapter.
  if (event === "srvCaps") {
    const caps = source === "rtc" ? message?.args?.[0] : payload;
    debugLog("transport", `[pm] srvCaps from host via ${source}: ${JSON.stringify(caps)}`);
    pm._srvCaps = caps || {};
    pm._adapters.get("rtc")?.setPeerCaps?.(pm._srvCaps);
  }
  // Resolve ack reply — may arrive via RTC or WS (host falls back to WS when RTC dies)
  if (event === "__ack") {
    const { ackId, args } = message || {};
    if (!ackId) return;
    const cb = pm._pendingAcks.get(ackId);
    if (cb) {
      pm._pendingAcks.delete(ackId);
      const t = pm._ackTimers.get(ackId);
      if (t) { clearTimeout(t); pm._ackTimers.delete(ackId); }
      cb(...(args || []));
    }
    return;
  }
  // Renegotiate fresh offer on device approval if previous RTC attempt died while waiting.
  if (event === "device:approved") {
    pm._awaitingApproval = false;
    const rtc = pm._adapters.get("rtc");
    if (pm._canSignal() && (!rtc || rtc.state === ADAPTER_STATE.closed)) {
      pm._restartRtc("device-approved");
    }
  }
  // Host test-toggle re-enabled RTC → clear the stop-retry flag and renegotiate.
  if (event === "rtc:enabled") {
    if (pm._rtcTestDisabled) {
      pm._rtcTestDisabled = false;
      termLog("switch", "rtc:enabled by host → clear flag + restart RTC");
      pm._restartRtc("rtc-enabled");
    }
    return;
  }
  if (event === "tunnel:updated") {
    const data = source === "rtc" ? message?.args?.[0] : payload;
    if (data) {
      const { tunnelUrl, localIp, status } = data as { tunnelUrl?: string; localIp?: string; status?: string };
      // Ignore tunnel update when current page origin is the host workspace.
      if (typeof window !== "undefined" && pm._auth.tunnelUrl === window.location?.origin) {
        termLog("switch", `tunnel:updated ignored (carrier is the page origin; got url=${tunnelUrl || "none"})`);
        return;
      }
      termLog("switch", `tunnel:updated recv (status=${status} url=${tunnelUrl || "none"})`);
      if (status === "ready" && tunnelUrl) {
        const urlChanged = pm._auth.tunnelUrl !== tunnelUrl;
        pm._auth.tunnelUrl = tunnelUrl;
        if (localIp) pm._auth.localIp = localIp;
        pm._wsCallbacks.onUrlUpdate?.({ tunnelUrl, localIp });
        const ws = pm._adapters.get("ws");
        if (ws && (!ws.ready || urlChanged)) {
          termLog("switch", `tunnel:updated → ${urlChanged ? "url changed" : "ws not ready"} → retry ws with new URL`);
          try { ws.retryNow?.("tunnel-updated"); } catch {}
        }
      } else if (status === "down") {
        pm._auth.tunnelUrl = "";
        pm._wsCallbacks.onUrlUpdate?.({ tunnelUrl: "", localIp });
      }
    }
    return;
  }
  const args = source === "rtc" && Array.isArray(message?.args)
    ? message.args
    : [payload];
  pm._bus?.dispatch(event, args);
}

// Route incoming binary frames to their lane's bus event (file → file-bin,
// mobile video → mobile-bin; WS delivers both as file-bin, self-tagged).
export function onBinary(pm: ProtocolManagerContext, msg: { channel: string; buffer: ArrayBuffer } | null | undefined) {
  if (!msg) return;
  if (msg.channel === "mobile") pm._bus?.dispatch("mobile-bin", [msg.buffer]);
  else if (msg.channel === "file") pm._bus?.dispatch("file-bin", [msg.buffer]);
}

// Idempotent read/create requests safe to retry over WS upon RTC ack timeout.
const ACK_RETRY_SAFE = new Set(["getSessions", "getWorkspaces", "bg:get", "bg:list", "ai:create", "ai:peekSeq", "aiSince"]);

export function scheduleAckTimeout(pm: ProtocolManagerContext, ackId: string, ctx?: { event: string; args: unknown[] }) {
  const timer = setTimeout(() => {
    pm._ackTimers.delete(ackId);
    debugLog("transport", `[pm] ack timeout ackId=${ackId} event=${ctx?.event} → suspect zombie RTC`);
    const cb = pm._pendingAcks.get(ackId);
    const rtc = pm._adapters.get("rtc");
    const ws = pm._adapters.get("ws");

    if (cb && ctx && ws?.ready && ACK_RETRY_SAFE.has(ctx.event)) {
      pm._pendingAcks.delete(ackId);
      termLog("switch", `ack-timeout ${ctx.event} → retry via ws (rtc zombie?)`);
      ws.send(CHANNELS.control as TransportChannel, { event: ctx.event, args: ctx.args, cb });
      return;
    }

    // Ignore timeout if RTC recently received inbound traffic (slow request, not dead carrier).
    const now = Date.now();
    const rtcLastInbound = rtc?.lastInboundAt || 0;
    if (rtc?.ready && rtcLastInbound && (now - rtcLastInbound < RTC_HEARTBEAT_LEGACY_TIMEOUT_MS)) {
      termLog("switch", `ack-timeout ${ctx?.event || "?"} ignored (rtc active, lastInbound=${now - rtcLastInbound}ms ago)`);
      return;
    }

    // Probe silent open peer via ICE keepalive before forcing restart.
    if (rtc?.state === ADAPTER_STATE.open) {
      probeRtcLiveness(pm, `ack-timeout:${ctx?.event || "?"}`);
      return;
    }

    pm._scheduleRtcRestart("ack-timeout");
  }, pm._ackTimeoutMs);
  pm._ackTimers.set(ackId, timer);
}
