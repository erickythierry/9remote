// WebPush Notification Management
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { PATHS, TOOL_LABELS } from "../../lib/constants.js";
import { pushUiLog } from "../../api/ui.js";
import { writeJsonAtomic } from "../../lib/atomicFile.js";

// web-push ships without type declarations; this is the surface used here.
type WebPushSubscription = { endpoint?: string; keys?: { p256dh: string; auth: string } };
type WebPushLib = {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: WebPushSubscription, payload: string): Promise<unknown>;
};
const require = createRequire(import.meta.url);
const webpush: WebPushLib = require("web-push");

type VapidKeys = { publicKey: string; privateKey: string };
type PushSub = {
  type?: string;
  token?: string;
  endpoint?: string;
  keys?: { p256dh: string; auth: string };
  deviceId?: string;
  socketId?: string;
  disconnectedAt?: number | null;
  lastConnectedAt?: number;
  hidden?: boolean;
};
export type PushNotification = { type: string; tool: string | null | undefined; sessionId: string; state?: string };

const VAPID_CONFIG_PATH = path.join(PATHS.CONFIG, "vapid.json");
const PUSH_SUBS_PATH = path.join(PATHS.CONFIG, "push-subscriptions.json");
const PUSH_OFFLINE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

// Push subscriptions: { endpoint, keys, deviceId, socketId, disconnectedAt }
let pushSubscriptions: PushSub[] = [];

function loadVapidKeys(): VapidKeys | null {
  try {
    if (fs.existsSync(VAPID_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(VAPID_CONFIG_PATH, "utf8"));
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

function saveVapidKeys(keys: VapidKeys) {
  const dir = path.dirname(VAPID_CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(VAPID_CONFIG_PATH, keys);
}

function initVapidKeys(): VapidKeys {
  let keys = loadVapidKeys();
  if (!keys) {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    saveVapidKeys(keys);
  }
  webpush.setVapidDetails("mailto:admin@9remote.cc", keys.publicKey, keys.privateKey);
  return keys;
}

function loadPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_PATH)) {
      pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, "utf8"));
    }
  } catch (e) {
    pushSubscriptions = [];
  }
}

function savePushSubscriptions() {
  try {
    const dir = path.dirname(PUSH_SUBS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(PUSH_SUBS_PATH, pushSubscriptions);
  } catch (e) {
    pushUiLog(`Failed to save push subscriptions: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Get unique identifier per subscription type
function getIdentifier(sub: PushSub): string | undefined {
  return sub.type === "expo" ? sub.token : sub.endpoint;
}

export function addPushSubscription(subscription: PushSub, socketId: string, deviceId?: string) {
  const id = getIdentifier(subscription);
  // Preserve prior visibility: a re-subscribe on reconnect must not reset a
  // backgrounded app to "focused" (which would swallow its push). The client
  // re-sends visibilityChange separately when it actually knows focus state.
  // Dedup by deviceId so iOS endpoint rotation (SW update) collapses to one entry
  // per device; also drop legacy entries lacking deviceId (live devices re-subscribe).
  const prev = pushSubscriptions.find(s => deviceId ? s.deviceId === deviceId : getIdentifier(s) === id);
  pushSubscriptions = pushSubscriptions.filter(s =>
    deviceId ? (s.deviceId && s.deviceId !== deviceId) : getIdentifier(s) !== id
  );
  pushSubscriptions.push({ ...subscription, deviceId, socketId, lastConnectedAt: Date.now(), hidden: prev?.hidden ?? false });
  savePushSubscriptions();
}

// Track app visibility per socket (from client visibilityChange) to gate push
export function setSubscriptionHidden(socketId: string, hidden: boolean) {
  for (const sub of pushSubscriptions) {
    if (sub.socketId === socketId) {
      sub.hidden = !!hidden;
      // Visible = app alive: clear stale disconnect from a transient socket drop
      if (!hidden) sub.disconnectedAt = null;
    }
  }
}

export function removePushSubscription(identifier: string) {
  pushSubscriptions = pushSubscriptions.filter(s => getIdentifier(s) !== identifier);
  savePushSubscriptions();
}

export function markSubscriptionDisconnected(socketId: string) {
  for (const sub of pushSubscriptions) {
    if (sub.socketId === socketId) sub.disconnectedAt = Date.now();
  }
  savePushSubscriptions();
}

export function markSubscriptionConnected(socketId: string, identifier: string) {
  for (const sub of pushSubscriptions) {
    if (getIdentifier(sub) === identifier) {
      sub.socketId = socketId;
      sub.disconnectedAt = null;
      sub.lastConnectedAt = Date.now();
    }
  }
  savePushSubscriptions();
}

async function sendExpoPush(sub: PushSub, toolName: string, notification: PushNotification) {
  const message = {
    to: sub.token,
    sound: "default",
    title: notification.type === "stop" ? `${toolName} ✅` : `${toolName} 🔔`,
    body: notification.type === "stop" ? `${toolName} finished its turn — your turn` : `${toolName} needs your input`,
    data: { url: `/workspace?t=${notification.sessionId}`, sessionId: notification.sessionId, type: notification.type }
  };
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
  const result: unknown = await res.json();
  if (typeof result !== "object" || result === null) throw new Error("Invalid Expo response");
  const data = "data" in result ? result.data : undefined;
  if (typeof data === "object" && data !== null && "status" in data && data.status === "error") {
    throw new Error("message" in data && typeof data.message === "string" ? data.message : undefined);
  }
  pushUiLog(`Expo push sent to ${sub.token?.slice(0, 30)}...`);
}

export async function sendPushNotification(notification: PushNotification) {
  const toolName = (TOOL_LABELS as Record<string, string | undefined>)[String(notification.tool)] || "AI";

  // Push to every sub that isn't actively foregrounded. iOS rotates the endpoint on
  // SW update, leaving dead entries; sending to all lets 410/404 prune them. The SW's
  // own visible-window backstop suppresses the banner when a client is actually focused.
  const targets = pushSubscriptions.filter(s => s.disconnectedAt != null || s.hidden);
  if (targets.length === 0) return;

  const expiredIds: (string | undefined)[] = [];
  await Promise.all(targets.map(async (sub) => {
    try {
      if (sub.type === "expo") {
        await sendExpoPush(sub, toolName, notification);
      } else {
        const payload = JSON.stringify({
          title: notification.type === "stop" ? `${toolName} ✅` : `${toolName} 🔔`,
          body: notification.type === "stop" ? `${toolName} finished its turn — your turn` : `${toolName} needs your input`,
          data: { url: `/workspace?t=${notification.sessionId}`, sessionId: notification.sessionId, type: notification.type }
        });
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
        pushUiLog(`WebPush sent to ${sub.endpoint?.slice(0, 50)}...`);
      }
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      const message = error instanceof Error ? error.message : String(error);
      pushUiLog(`Push failed: ${statusCode || message}`);
      const isExpired = statusCode === 410 || statusCode === 404 || message.includes("DeviceNotRegistered");
      if (isExpired) expiredIds.push(getIdentifier(sub));
    }
  }));

  if (expiredIds.length) {
    pushSubscriptions = pushSubscriptions.filter(s => !expiredIds.includes(getIdentifier(s)));
    savePushSubscriptions();
  }
}

// Initialize VAPID keys and load subscriptions on import
const vapidKeys = initVapidKeys();
loadPushSubscriptions();

export function getVapidPublicKey() {
  return vapidKeys.publicKey;
}
