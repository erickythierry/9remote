// Device auth — proof of the v2 key TAIL.
import crypto from "crypto";
import { createLogger } from "./logger.js";
import { approveDevice, markTailProven, hasProvenTail, gateDevice, isDeviceKicked, removeDevice } from "./deviceApproval.js";
import { matchesPairingTail, consumePairingTail, getActivePairing } from "./pairingCode.js";
import { CHANNELS, ADMISSION, DEVICE_GATE, TAIL_VERDICT, TAIL_REJECT_REASON } from "./transportConstants.js";
import { tailOf, headOf } from "../cli/utils/apiKey.js";
import { loadKey } from "../cli/utils/state.js";
import { openSealedTail } from "./hostKey.js";
import type { ConnectionData } from "../transport/Connection.js";

const logger = createLogger("deviceAuth");

function hostTail() {
  return tailOf(loadKey()?.key || "");
}

export function isTailProofEnabled() {
  return !!hostTail();
}

// Tail-guess rate limiting anchored on key head (RAM only).
const TAIL_FAIL_THRESHOLD = 5;
const TAIL_PENALTY_BASE_MS = 1000;
const TAIL_PENALTY_MAX_MS = 60 * 1000;
const TAIL_FAIL_WINDOW_MS = 60 * 60 * 1000;
const TAIL_PENDING_CAP = 20;
type TailVerdict = { keyHead: string | null; state: string; reason: string | null; since: number };
type AuthSocket = {
  data: ConnectionData & { tailReject?: { reason: string | null | undefined; penaltyMs: number }; tailRejectFinished?: boolean };
  handshake?: { auth?: { deviceId?: string | null; tempKey?: string | null; keyTail?: string; keyTailSealed?: Parameters<typeof openSealedTail>[0] } };
  deviceId?: string | null;
  emit: (event: string, ...args: unknown[]) => unknown;
  disconnect: () => unknown;
};

const tailFailsByKey = new Map<string | null, number[]>(); // keyHead -> ts[]
let tailPendingRejects = 0;

// One admission verdict per device across carriers.
const verdicts = new Map<string, TailVerdict>();
const PROOF_DEADLINE_MS = 20000;

function verdictOf(deviceId: string | null | undefined, keyHead: string | null): TailVerdict | null {
  const v = deviceId ? verdicts.get(deviceId) : null;
  if (!v || v.keyHead !== keyHead) return null;
  return v;
}

function setVerdict(deviceId: string | null | undefined, keyHead: string | null, state: string, reason: string | null = null): void {
  if (!deviceId) return;
  const prev = verdicts.get(deviceId);
  verdicts.set(deviceId, { keyHead, state, reason, since: Date.now() });
  if (state === prev?.state) return;
  if (state === TAIL_VERDICT.proven) flushProofWaiters(deviceId);
  if (state === TAIL_VERDICT.rejected) proofWaiters.delete(deviceId);
}

// Submit tail proof from any carrier (handshake or data channel).
export function submitTailProof(deviceId: string | null | undefined, tail: string | null, { pairing = false, tempKey = null }: { pairing?: boolean; tempKey?: string | null } = {}): boolean {
  const keyHead = headOf(loadKey()?.key || "");
  if (!deviceId || (!isTailProofEnabled() && !pairing)) return false;
  const proof = pairing ? consumePairingTail(tail, tempKey) : { match: verifyKeyTail(tail) };
  if (proof.match) {
    setVerdict(deviceId, keyHead, TAIL_VERDICT.proven);
    markTailProven(deviceId, keyHead);
    logger.info(`[seal] proof accepted: device=${deviceId.slice(0, 8)}`);
    return true;
  }
  const reason = tail === null ? TAIL_REJECT_REASON.sealUnreadable : TAIL_REJECT_REASON.mismatch;
  setVerdict(deviceId, keyHead, TAIL_VERDICT.rejected, reason);
  logger.warn(`[seal] proof rejected (${reason}): device=${deviceId.slice(0, 8)}`);
  return false;
}

export function isProvingExpired(deviceId: string): boolean {
  const v = verdictOf(deviceId, headOf(loadKey()?.key || ""));
  return !!v && v.state === TAIL_VERDICT.proving && Date.now() - v.since > PROOF_DEADLINE_MS;
}

export function verdictStateOf(deviceId: string): string | null {
  return verdictOf(deviceId, headOf(loadKey()?.key || ""))?.state || null;
}

const proofWaiters = new Map<string, Set<() => void>>();

// Run fn once device has proven tail.
export function onTailProven(deviceId: string | null | undefined, fn: () => void, onExpired?: () => void): void {
  if (!deviceId || !isTailProofEnabled()) return fn();
  if (verdictStateOf(deviceId) === TAIL_VERDICT.proven) return fn();
  let waiters = proofWaiters.get(deviceId);
  if (!waiters) {
    waiters = new Set();
    proofWaiters.set(deviceId, waiters);
  }
  waiters.add(fn);
  if (!onExpired) return;
  setTimeout(() => {
    const set = proofWaiters.get(deviceId);
    if (!set?.delete(fn)) return;
    if (!set.size) proofWaiters.delete(deviceId);
    onExpired();
  }, PROOF_DEADLINE_MS);
}

function flushProofWaiters(deviceId: string): void {
  const set = proofWaiters.get(deviceId);
  if (!set) return;
  proofWaiters.delete(deviceId);
  for (const fn of set) { try { fn(); } catch {} }
}

export function clearProofWaiters(deviceId: string): void {
  proofWaiters.delete(deviceId);
}

export const PROOF_DEADLINE = PROOF_DEADLINE_MS;

export function noteTailFailure(keyHead: string | null): number {
  const now = Date.now();
  const fails = (tailFailsByKey.get(keyHead) || []).filter((t) => now - t < TAIL_FAIL_WINDOW_MS);
  fails.push(now);
  tailFailsByKey.set(keyHead, fails);
  const over = fails.length - TAIL_FAIL_THRESHOLD;
  if (over <= 0) return 0;
  return Math.min(TAIL_PENALTY_BASE_MS * 2 ** (over - 1), TAIL_PENALTY_MAX_MS);
}

export function verifyPresentedTail({ tail, tempKey }: { tail?: string | null; tempKey?: string | null } = {}): { ok: boolean; reason?: string; burned?: boolean; penaltyMs?: number } {
  const pairing = !!tempKey;
  if (!pairing && !isTailProofEnabled()) return { ok: true };
  if (!tail) return { ok: false, reason: TAIL_REJECT_REASON.mismatch, penaltyMs: 0 };

  const proof: { match: boolean; burned?: boolean } = pairing ? consumePairingTail(tail, tempKey) : { match: verifyKeyTail(tail) };
  if (proof.match) return { ok: true };
  return {
    ok: false,
    reason: TAIL_REJECT_REASON.mismatch,
    burned: !!proof.burned,
    penaltyMs: noteTailFailure(headOf(loadKey()?.key || ""))
  };
}

// Admission gate: authenticate key, then authorize device.
export function admissionGate(deviceId: string | null | undefined, presented: string | null | undefined, { provenSocket = false, tempKey = null }: { provenSocket?: boolean; tempKey?: string | null } = {}): { step: "auth" | "authz"; decision: string; reason?: string | null } {
  const keyHead = headOf(loadKey()?.key || "");
  const gate = gateDevice(deviceId);

  if (gate === DEVICE_GATE.rejected) {
    return { step: "authz", decision: ADMISSION.reject, reason: "device-rejected" };
  }

  const pairingSession = !!tempKey && !!deviceId && !isDeviceKicked(deviceId);
  if (pairingSession) {
    const live = getActivePairing();
    logger.info(`[pair] device=${deviceId?.slice(0, 8)} presented=${presented === undefined ? "none" : String(presented).length + "ch"} ` +
      `liveCode=${live ? "yes" : "no"} liveTail=${live?.tail ? String(live.tail).length + "ch" : "none"} ` +
      `match=${presented === undefined ? "n/a" : matchesPairingTail(String(presented))}`);
  }
  if (isTailProofEnabled() || pairingSession) {
    const verdict = verdictOf(deviceId, keyHead);
    // Retain refusal when nothing presented to prevent brute-force retry loops.
    if (verdict?.state === TAIL_VERDICT.rejected && presented === undefined) {
      return { step: "auth", decision: ADMISSION.reject, reason: verdict.reason };
    }
    const matches = (t: string | null) => (pairingSession ? matchesPairingTail(t) : verifyKeyTail(t));
    const proven = provenSocket
      || verdict?.state === TAIL_VERDICT.proven
      || (presented !== undefined && matches(presented));
    if (!proven) {
      if (presented !== undefined) {
        return {
          step: "auth",
          decision: ADMISSION.reject,
          reason: presented === null ? TAIL_REJECT_REASON.sealUnreadable : TAIL_REJECT_REASON.mismatch
        };
      }
      return { step: "auth", decision: ADMISSION.hold, reason: "awaiting-proof" };
    }
  }

  if (gate === DEVICE_GATE.approved || gate === DEVICE_GATE.auto) {
    return { step: "authz", decision: ADMISSION.admit };
  }
  return { step: "authz", decision: ADMISSION.hold, reason: "host-decides" };
}

// Constant-time key tail verification.
export function verifyKeyTail(presentedTail: string | null | undefined): boolean {
  const tail = hostTail();
  if (!tail || !presentedTail) return false;
  const a = Buffer.from(String(presentedTail), "utf8");
  const b = Buffer.from(tail, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Extract presented tail (sealed with host X25519 key or plain).
export function presentedTailOf(auth: { keyTailSealed?: Parameters<typeof openSealedTail>[0]; keyTail?: string } | null, open: (sealed: Parameters<typeof openSealedTail>[0]) => string | null): string | null | undefined {
  const sealed = auth?.keyTailSealed;
  if (sealed !== undefined) {
    if (!sealed || typeof sealed !== "object" || Array.isArray(sealed)) return null;
    return open(sealed) ?? null;
  }
  return auth?.keyTail;
}

// Handle proof over an open carrier (e.g. RTC data channel).
export function handleTailProof(socket: Pick<AuthSocket, "data" | "handshake" | "deviceId">, data: { tempKey?: string | null; keyTail?: string; keyTailSealed?: Parameters<typeof openSealedTail>[0] } | null): boolean {
  const deviceId = socket?.data?.auth?.deviceId || socket.handshake?.auth?.deviceId || socket.deviceId || null;
  // The proof's own tempKey wins when present: an explicit null ends pairing (keyIssued cleared it client-side), else the WS handshake — frozen at connect — judges the KEY tail against the CODE tail and burns a used code.
  const presentedTemp = data && "tempKey" in data
    ? (data.tempKey || null)
    : (socket.handshake?.auth?.tempKey || null);
  const pairing = !!presentedTemp && !!getActivePairing();
  if (!deviceId || (!isTailProofEnabled() && !pairing)) return true;
  const tail = presentedTailOf(data, openSealedTail);
  if (tail === undefined) return true;
  if (submitTailProof(deviceId, tail, { pairing, tempKey: presentedTemp })) return true;
  socket.data.tailReject = {
    reason: tail === null ? TAIL_REJECT_REASON.sealUnreadable : TAIL_REJECT_REASON.mismatch,
    penaltyMs: noteTailFailure(headOf(loadKey()?.key || ""))
  };
  return false;
}

// Deliver tail rejection after rate-limit penalty, then drop socket.
export function finishTailRejection(socket: AuthSocket, onClosed?: () => void): void {
  if (socket.data?.tailRejectFinished) return;
  socket.data.tailRejectFinished = true;
  const { reason, penaltyMs = 0 } = socket.data?.tailReject || {};
  const overCap = tailPendingRejects >= TAIL_PENDING_CAP;
  const wait = overCap ? 0 : penaltyMs;
  if (!overCap) tailPendingRejects++;
  setTimeout(() => {
    if (!overCap) tailPendingRejects--;
    try {
      socket.emit("device:tailRejected", { reason });
      socket.disconnect();
    } catch {}
    onClosed?.();
  }, wait);
}
