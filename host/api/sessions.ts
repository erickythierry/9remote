import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * PTY session list/delete handlers (localhost-only)
 */

import * as daemonClient from "../features/terminal/ptyDaemonClient.js";
import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";

export async function handleSessionsList(req: IncomingMessage, res: ServerResponse) {
  try {
    const sessions = await daemonClient.listSessions();
    jsonOk(res, { sessions });
  } catch (e) {
    jsonErr(res, 500, (e as Error).message);
  }
}

export async function handleSessionDelete(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ sessionId?: string }>(req, res);
  if (!data) return;
  if (!data.sessionId) return jsonErr(res, 400, "sessionId required");
  try {
    await daemonClient.deleteSession(data.sessionId);
    jsonOk(res);
  } catch (e) {
    jsonErr(res, 500, (e as Error).message);
  }
}
