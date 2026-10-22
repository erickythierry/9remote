import type { McpTool, ToolArguments } from "../../mcp/types.js";
import type { KanbanAction } from "./jarvisKanban.js";
type Reply = (result: object) => void;
type JarvisEvents = {
  "jarvis:getState": (data: unknown, cb?: Reply) => void;
  "jarvis:kanban": (data: { action?: KanbanAction }, cb?: Reply) => void;
  "jarvis:tools": (data: unknown, cb?: Reply) => void;
  "jarvis:tool": (data: { name?: string; args?: ToolArguments }, cb?: Reply) => void;
  "jarvis:agentConfig": (data: { apiKey?: string; model?: string; wake?: unknown }, cb?: Reply) => void;
  "jarvis:chatHistory": (data: unknown, cb?: Reply) => void;
  "jarvis:chat": (data: { text?: unknown }, cb?: Reply) => void;
};
type JarvisSocket = { on<E extends keyof JarvisEvents>(event: E, handler: JarvisEvents[E]): unknown };
// The web's doors into Jarvis: read the board + fleet, apply hand moves, run
// coordinator tools, and drive the standalone chat agent (config, turns,
// history). Everything here answers the authenticated user over the socket.
import { fleetSnapshot } from "./fleetRunner.js";
import { foldFleetIntoBoard, applyAndBroadcast } from "./jarvisState.js";
import { setWakeEnabled, initJarvisWakeListener } from "./jarvisWake.js";
import { setAgentConfig, loadAgentConfig, agentStatus, jarvisTurn, chatHistory } from "./jarvisAgent.js";
import { JARVIS_TOOLS, jarvisToolManifest } from "../../mcp/tools/jarvis/index.js";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("jarvis");

let jarvisEnabled = false;
export const isJarvisEnabled = () => jarvisEnabled;
export const setJarvisEnabledForTests = (v: unknown) => { jarvisEnabled = !!v; };

const push = (event: string, data: unknown) => {
  const io = getIO();
  if (io) broadcast(io, event, data);
};

export function setupJarvisHandlers(socket: JarvisSocket) {
  if (!jarvisEnabled) return;
  // Every open view re-arms the worker-finish listener; the guard inside makes it once.
  initJarvisWakeListener();
  // Restore the persisted LLM config (provider/key/model) — a restart must not
  // forget it. Idempotent inside.
  void loadAgentConfig();

  socket.on("jarvis:getState", async (_data, cb) => {
    try {
      // One read, one truth: fold the live fleet into the board's auto cards
      // first (on the shared write queue, so a concurrent report cannot be
      // erased by this fold's save), then hand the user that board.
      const fleet = await fleetSnapshot();
      const board = await foldFleetIntoBoard(fleet);
      cb?.({ ok: true, board, fleet });
    } catch (err) {
      logger.error(`getState failed: ${(err as Error).message}`);
      cb?.({ ok: false, error: (err as Error).message });
    }
  });

  // A board move the user made by hand — same reducer, same broadcast, so the
  // mirror and the conductor's next list stay one board.
  socket.on("jarvis:kanban", async ({ action } = {}, cb) => {
    try {
      const res = await applyAndBroadcast(action!, "web");
      cb?.(res.error ? { ok: false, error: res.error } : { ok: true, board: res.board });
    } catch (err) {
      logger.error(`kanban action failed: ${(err as Error).message}`);
      cb?.({ ok: false, error: (err as Error).message });
    }
  });

  // The tool doors: manifest for the live-voice declarations, execution for both
  // live voice and anything else the web drives. Same tool instances everywhere.
  socket.on("jarvis:tools", (_d, cb) => cb?.({ ok: true, tools: jarvisToolManifest() }));

  socket.on("jarvis:tool", async ({ name, args } = {}, cb) => {
    const tool = JARVIS_TOOLS.find((t) => t.name === name);
    if (!tool) return cb?.({ ok: false, error: `unknown tool: ${name}` });
    try {
      const res = await tool.run(args || {}, { sessionId: "jarvis-live" });
      cb?.((res as { error?: unknown } | null)?.error ? { ok: false, error: (res as { error: unknown }).error } : { ok: true, result: typeof res === "string" ? res : JSON.stringify(res) });
    } catch (err) {
      logger.error(`live tool ${name} failed: ${(err as Error).message}`);
      cb?.({ ok: false, error: (err as Error).message });
    }
  });

  // The standalone chat agent. Config is memory-only; a turn streams its steps
  // to every web mirror as they happen.
  socket.on("jarvis:agentConfig", ({ apiKey, model, wake } = {}, cb) => {
    setAgentConfig({ apiKey, model });
    if (wake !== undefined) setWakeEnabled(!!wake);
    cb?.({ ok: true, ...agentStatus() });
  });

  socket.on("jarvis:chatHistory", async (_d, cb) => {
    try { cb?.({ ok: true, history: await chatHistory() }); }
    catch (e) { cb?.({ ok: false, error: (e as Error).message }); }
  });

  socket.on("jarvis:chat", async ({ text } = {}, cb) => {
    if (!text || typeof text !== "string") return cb?.({ ok: false, error: "text is required" });
    push("jarvis:chat:event", { type: "user", text: text.slice(0, 2000) });
    const res = await jarvisTurn(text, (type, data) => push("jarvis:chat:event", { type, ...data }));
    cb?.(res.error ? { ok: false, error: res.error } : { ok: true, text: res.text });
  });
}
