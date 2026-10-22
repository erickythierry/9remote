import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * Device approval handlers (localhost-only)
 */

import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import { approveSocketDevice, rejectSocketDevice, disconnectDeviceSockets, approveRejectedDevice } from "../transport/server.js";
import { getAllPendingApprovals, getApprovedDevices, removeDevice, getRejectedDevices, clearRejectedDevice, kickDevice, isAutoApprove, setAutoApprove, setDeviceLabel } from "../lib/deviceApproval.js";

export async function handleApprove(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  const ok = approveSocketDevice(data.socketId);
  jsonOk(res, { ok });
}

export async function handleReject(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  const ok = rejectSocketDevice(data.socketId);
  jsonOk(res, { ok });
}

export function handlePending(req: IncomingMessage, res: ServerResponse) {
  jsonOk(res, { pending: getAllPendingApprovals() });
}

export function handleApproved(req: IncomingMessage, res: ServerResponse) {
  jsonOk(res, { devices: getApprovedDevices() });
}

export function handleRejected(req: IncomingMessage, res: ServerResponse) {
  jsonOk(res, { rejected: getRejectedDevices() });
}

export async function handleApproveRejected(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  const ok = approveRejectedDevice(data.deviceId);
  jsonOk(res, { ok });
}

export async function handleClearRejected(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  disconnectDeviceSockets(data.deviceId);
  clearRejectedDevice(data.deviceId);
  jsonOk(res);
}

export async function handleRemove(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  disconnectDeviceSockets(data.deviceId);
  removeDevice(data.deviceId);
  jsonOk(res);
}

export async function handleDisconnect(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  // Disconnect = kick + require re-approval: the client's next connect lands in
  // the pending flow ("waiting for approval" modal) instead of silently returning.
  kickDevice(data.deviceId);
  const count = disconnectDeviceSockets(data.deviceId);
  jsonOk(res, { disconnected: count });
}

export function handleGetAutoApprove(req: IncomingMessage, res: ServerResponse) {
  jsonOk(res, { enabled: isAutoApprove() });
}

export async function handleSetLabel(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  const ok = setDeviceLabel(data.deviceId, data.label);
  jsonOk(res, { ok });
}

export async function handleSetAutoApprove(req: IncomingMessage, res: ServerResponse) {
  const data = await parseJsonBody<{ deviceId: string; socketId: string; label?: string; enabled?: boolean }>(req, res);
  if (!data) return;
  const enabled = setAutoApprove(!!data.enabled);
  jsonOk(res, { enabled });
}
