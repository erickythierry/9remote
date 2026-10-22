import type { IncomingMessage, ServerResponse } from "node:http";
// Remote access on/off — localhost-only (agent UI). Persisted in settings.json;
// off drops remote clients and the DO relay, on re-runs the connect steps.
import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import { saveSettings, writeCmd } from "../cli/utils/state.js";
import { setRemoteEnabled, isRemoteEnabled } from "../transport/server.js";
import { pushUiEvent } from "./ui.js";
import { SELF_HOSTED } from "../cli/config.js";

function payload(enabled: boolean) {
  return { enabled };
}

export function handleRemoteEnabledGet(req: IncomingMessage, res: ServerResponse) {
  // Self-hosted: Worker/tunnel remote is off, but VPN access is always on — that is what the dash should show.
  if (SELF_HOSTED) return jsonOk(res, { enabled: true, selfHosted: true });
  jsonOk(res, payload(isRemoteEnabled()));
}

export async function handleRemoteEnabledPost(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ enabled?: unknown }>(req, res);
  if (!data) return; // parseJsonBody already answered 400
  if (typeof data.enabled !== "boolean") return jsonErr(res, 400, "enabled must be a boolean");
  if (SELF_HOSTED && data.enabled) return jsonErr(res, 409, "Remote access is unavailable in self-hosted mode");
  saveSettings({ remoteEnabled: data.enabled });
  setRemoteEnabled(data.enabled);
  // The CLI parent owns the tunnel process and the step machine
  writeCmd(data.enabled ? "start-tunnel" : "stop-tunnel");
  const p = payload(data.enabled);
  pushUiEvent("remote", p);
  jsonOk(res, p);
}
