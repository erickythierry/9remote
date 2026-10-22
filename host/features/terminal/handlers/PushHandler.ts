import { getVapidPublicKey, addPushSubscription, removePushSubscription, markSubscriptionConnected, setSubscriptionHidden } from "../pushManager.js";
// enableToolHook/getHookStatus kept for reference (hooks auto-enabled on startup, not toggled by clients)
import { getNotifications, getStatuses, clearStatus, STATES } from "../statusManager.js";
import { getAutoStartStatus, setAutoStart, isCodespaces } from "../codespaceManager.js";
import { writeCmd } from "../../../cli/utils/state.js";
import { scanLocalSites } from "../portScanner.js";
import { setMcpEnabled, MCP_CLIENTS } from "../../../mcp/mcpConfig.js";
import { readSettings, writeSettings } from "../../../lib/settings.js";
import { transcribeViaOpencode, MAX_AUDIO_B64_CHARS } from "../opencodeStt.js";
import { broadcast } from "../../../transport/broadcast.js";
type PushSubscription = { type?: string; token?: string; endpoint?: string; keys?: { p256dh: string; auth: string } };
type Ack = (result: Record<string, unknown>) => void;
type VoiceConfig = Parameters<typeof writeSettings>[0]["voiceConfig"];
type PushSocket = {
  id: string;
  data?: { auth?: { deviceId?: string } };
  handshake?: { auth?: { deviceId?: string } };
  emit(event: string, ...args: unknown[]): unknown;
  on(event: "getStatusState" | "getNotificationState" | "requestUpdate" | "requestRestart", listener: () => void): unknown;
  on(event: "getLocalSites", listener: (callback?: unknown) => void): unknown;
  on(event: "clearStatus" | "clearNotification", listener: (sessionId: string) => void): unknown;
  on(event: "getVapidKey" | "getVoiceConfig", listener: (callback?: Ack) => void): unknown;
  on(event: "getAutoStartStatus", listener: (callback: Ack) => void): unknown;
  on(event: "pushSubscribe", listener: (subscription: PushSubscription) => void): unknown;
  on(event: "pushUnsubscribe", listener: (identifier: string) => void): unknown;
  on(event: "visibilityChange", listener: (hidden: boolean) => void): unknown;
  on(event: "setArtifactEnabled", listener: (payload: { enabled: boolean }, callback?: Ack) => void): unknown;
  on(event: "setVoiceConfig", listener: (payload: { voiceConfig?: VoiceConfig }, callback?: Ack) => void): unknown;
  on(event: "voice:transcribe", listener: (payload: { audioB64?: unknown; format?: string; model?: string; prompt?: unknown }, callback?: Ack) => void): unknown;
  on(event: "setAutoStart", listener: (payload: { enabled: boolean }, callback: Ack) => void): unknown;
};

export function setupPushHandlers(socket: unknown, io: unknown): void {
  const eventSocket = socket as PushSocket;
  // Full 4-state map (idle/working/blocked/done). New name; UI consumes this.
  eventSocket.on("getStatusState", () => {
    eventSocket.emit("statusState", getStatuses());
  });

  // Legacy: only done/blocked truthy map. Kept for older web clients.
  eventSocket.on("getNotificationState", () => {
    eventSocket.emit("notificationState", getNotifications());
  });

  // Local sites over the socket bus — works on RTC where the tunnel URL may be stale/absent
  eventSocket.on("getLocalSites", async (callback) => {
    if (typeof callback !== "function") return;
    try {
      callback({ sites: await scanLocalSites() });
    } catch (err) {
      callback({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Trigger agent self-update via socket (authenticated, no HTTP through tunnel)
  eventSocket.on("requestUpdate", async () => {
    const { pushUiEvent } = await import("../../../api/ui.js");
    pushUiEvent("updating", {});
    writeCmd("update");
  });

  // Restart agent host (no reinstall): kill + relaunch, ptyDaemon survives
  eventSocket.on("requestRestart", () => writeCmd("restart"));

  // Clear on focus/input/switch → idle. Only broadcast when a DONE entry was actually cleared;
  // working/blocked must survive focus so a running agent keeps its spinner.
  eventSocket.on("clearStatus", (sessionId) => {
    if (!sessionId) return;
    const cleared = clearStatus(sessionId);
    if (cleared) {
      broadcast(null, "statusCleared", sessionId);
      broadcast(null, "notificationCleared", sessionId);
    }
  });
  eventSocket.on("clearNotification", (sessionId) => {
    if (!sessionId) return;
    const cleared = clearStatus(sessionId);
    if (cleared) {
      broadcast(null, "notificationCleared", sessionId);
      broadcast(null, "statusCleared", sessionId);
    }
  });

  eventSocket.on("getVapidKey", (callback) => callback?.({ key: getVapidPublicKey() }));

  eventSocket.on("pushSubscribe", (subscription) => {
    const identifier = subscription?.type === "expo" ? subscription.token : subscription?.endpoint;
    if (!identifier) return;
    markSubscriptionConnected(eventSocket.id, identifier);
    // Device identity reads the normalized field first — the handshake is the
    // socket.io spelling of the same thing and stays for real-socket hosts.
    addPushSubscription(subscription, eventSocket.id, eventSocket.data?.auth?.deviceId ?? eventSocket.handshake?.auth?.deviceId);
  });

  eventSocket.on("pushUnsubscribe", (identifier) => {
    if (identifier) removePushSubscription(identifier);
  });

  eventSocket.on("visibilityChange", (hidden) => setSubscriptionHidden(eventSocket.id, hidden));

  // Hooks are always auto-enabled on agent startup (badge in-app source); enable/disable/status not exposed to clients
  // socket.on("enableHook", async ({ tool }, callback) => { try { callback(await enableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); } });
  // socket.on("disableHook", async ({ tool }, callback) => { try { callback(await disableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); } });
  // socket.on("getHookStatus", (callback) => callback(getHookStatus()));

  // Artifact MCP: one switch that writes the endpoint into every AI CLI's own config.
  // A running CLI reads its config at startup, so the change lands on its next launch.
  eventSocket.on("setArtifactEnabled", async ({ enabled } = { enabled: false }, callback) => {
    const value = setMcpEnabled(enabled);
    callback?.({ success: true, enabled: value, clients: MCP_CLIENTS });
    // Every other client mirrors this setting — imported lazily because terminalSocket
    // is what mounts these handlers, so a static import would close the cycle.
    const { broadcastServerInfo } = await import("../terminalSocket.js");
    broadcastServerInfo();
  });

  eventSocket.on("getVoiceConfig", (callback) => {
    callback?.({ success: true, voiceConfig: readSettings().voiceConfig || null });
  });

  eventSocket.on("setVoiceConfig", async ({ voiceConfig } = {}, callback) => {
    const next = writeSettings({ voiceConfig });
    callback?.({ success: true, voiceConfig: next?.voiceConfig || null });
    const { broadcastServerInfo } = await import("../terminalSocket.js");
    broadcastServerInfo();
  });

  // Free-tier voice STT runs agent-side: opencode.ai serves no CORS, so the browser can't call it
  eventSocket.on("voice:transcribe", async ({ audioB64, format, model, prompt } = {}, callback) => {
    if (typeof callback !== "function") return;
    if (typeof audioB64 !== "string" || !audioB64) return callback({ error: "bad-audio" });
    if (audioB64.length > MAX_AUDIO_B64_CHARS) return callback({ error: "audio-too-large" });
    if (!format || !["mp3", "wav"].includes(format)) return callback({ error: "bad-format" });
    if (!model || !/^[\w.-]+$/.test(model)) return callback({ error: "bad-model" });
    try {
      const text = await transcribeViaOpencode(model, audioB64, String(prompt || "").slice(0, 2000), format);
      callback({ text });
    } catch (err) {
      callback({ error: err instanceof Error ? err.message : "STT failed" });
    }
  });

  eventSocket.on("getAutoStartStatus", (callback) => {
    if (!isCodespaces()) return callback({ success: false, error: "Not in Codespaces" });
    const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
    callback({ success: true, ...getAutoStartStatus(workspacePath) });
  });

  eventSocket.on("setAutoStart", ({ enabled }, callback) => {
    if (!isCodespaces()) return callback({ success: false, error: "Not in Codespaces" });
    const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
    callback(setAutoStart(workspacePath, enabled));
  });
}
