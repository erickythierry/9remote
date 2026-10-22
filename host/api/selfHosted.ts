import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * Self-hosted stand-ins for the Worker endpoints the web client calls.
 * The host is the only server, so "resolve my host" always answers with itself.
 */

import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import { loadKey } from "../cli/utils/state.js";
import { headOf, matchesLocalKey } from "../cli/utils/apiKey.js";
import { getActivePairing } from "../lib/pairingCode.js";
import { clearOneTimeKey } from "./ui.js";
import { noteTailFailure } from "../lib/deviceAuth.js";
import { getHostPublicKeyB64, getHostX25519PublicKeyB64 } from "../lib/hostKey.js";
import { PUBLIC_ORIGIN } from "../cli/config.js";

const TEMP_KEY_LENGTH = 6;
// Codes a client already redeemed; the Worker deletes the row, here /api/connect just refuses them.
// shortcut: in-memory, a host restart forgets it; the pairing window's own 10-min TTL still bounds it.
const retiredCodes = new Set<string>();

/** The origin the client used to reach us — that is the "tunnel" in a single-host VPN.
 *  Prefer the page's own Origin so the client sees tunnelUrl === location.origin (direct WS, no refresh loop). */
function originOf(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return req.headers.host ? `http://${req.headers.host}` : PUBLIC_ORIGIN;
}

/** Pairing code the host minted, matched case-insensitively and only while live. */
function livePairing(code: unknown) {
  const active = getActivePairing();
  const presented = String(code || "").trim().toUpperCase().slice(0, TEMP_KEY_LENGTH);
  if (!active?.tempKey || !presented || retiredCodes.has(presented)) return null;
  return active.tempKey.toUpperCase() === presented ? active : null;
}

function reject(res: ServerResponse, status: number, msg: string, key: string) {
  // Same shared counter as tail proofs: guessing a HEAD must not be cheaper here.
  const penaltyMs = noteTailFailure(headOf(key || "")!);
  setTimeout(() => jsonErr(res, status, msg), penaltyMs);
}

/** POST /api/connect — { apiKey } (HEAD) or { token | tempKey } (pairing code). */
export async function handleSelfHostedConnect(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ apiKey?: string; token?: unknown; tempKey?: string }>(req, res);
  if (!data) return;
  const key = loadKey()?.key || "";
  if (!key) return jsonErr(res, 503, "Server not ready. Please wait...");

  const code = data.tempKey || (typeof data.token === "string" && data.token.length <= 10 ? data.token : null);
  let tempKey: string | null = null;
  if (code) {
    const pairing = livePairing(code);
    if (!pairing) return reject(res, 401, "Invalid or expired temp key", key);
    tempKey = pairing.tempKey!.toUpperCase();
  } else if (!matchesLocalKey(data.apiKey, key)) {
    return reject(res, 401, "Invalid API key", key);
  }

  jsonOk(res, {
    tunnelUrl: originOf(req),
    apiKey: headOf(key),
    tempKey,
    localIp: null,
    hostKeys: { ed: getHostPublicKeyB64(), x: getHostX25519PublicKeyB64() },
  });
}

/** DELETE /api/temp-key/remove — client retires the code it redeemed. Mirrors the Worker:
 *  the code stops being shown/redeemable, the pairing window itself keeps its own TTL. */
export async function handleSelfHostedTempKeyRemove(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ apiKey?: string; token?: unknown; tempKey?: string }>(req, res);
  if (!data) return;
  const pairing = livePairing(data.tempKey);
  if (pairing) {
    retiredCodes.add(pairing.tempKey!.toUpperCase());
    clearOneTimeKey();
  }
  const removed = !!pairing;
  jsonOk(res, { success: true, removed });
}

/** GET /api/webrtc/turn-credentials — no TURN inside the VPN; peers reach each other directly. */
export function handleSelfHostedTurnCredentials(req: IncomingMessage, res: ServerResponse) {
  jsonOk(res, { iceServers: [] });
}
