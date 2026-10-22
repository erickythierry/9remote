import type { IncomingMessage, ServerResponse } from "node:http";
// Windows desktop unlock bridge — localhost-only (agent UI + remote socket).
// Sensitive: TYPE carries the user's login text → never log the body.
import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import * as bridge from "../lib/desktopBridge.js";

export async function handleDesktopUnlockGet(req: IncomingMessage, res: ServerResponse) {
  const status = await bridge.getStatus();
  jsonOk(res, status);
}

export async function handleDesktopUnlockInstall(req: IncomingMessage, res: ServerResponse) {
  const result = await bridge.install();
  // Merge fresh status so the UI gets `running`/`built` immediately — install()
  // itself only returns {ok, reason}, which would leave the Grant button stale.
  const status = await bridge.getStatus();
  jsonOk(res, { ...result, ...status });
}

export async function handleDesktopUnlockType(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ text?: unknown }>(req, res);
  if (!data) return;
  if (typeof data.text !== "string" || !data.text) {
    jsonErr(res, 400, "Missing text");
    return;
  }
  // Reason is the only field surfaced — never echo the text back.
  const result = await bridge.typeText(data.text);
  jsonOk(res, { ok: result.ok, reason: result.reason || null });
}

export async function handleDesktopUnlockUninstall(_req: IncomingMessage, res: ServerResponse) {
  const result = await bridge.uninstall();
  // Merge fresh status so the UI reflects the real running state immediately.
  const status = await bridge.getStatus();
  jsonOk(res, { ...result, ...status });
}
