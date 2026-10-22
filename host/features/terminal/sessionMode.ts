// Switching one terminal between the agent CLI running in it and the chat UI.
// The host owns the switch: it knows the conversation and can move the daemon's AI
// session, neither of which a client may decide on its own.
import * as daemonClient from "./ptyDaemonClient.js";
import { globalAiManager } from "../ai/aiManager.js";
import { resumeCommand } from "./agentHistory.js";
import { agentById } from "./agentCatalog.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import {
  getConversation, getSessionAgent, setSessionAgent, setConversationId, clearSessionAgent
} from "./statusManager.js";
import { MODE, engineFromAgent } from "./conversationModes.js";
import { surfaceAgent } from "./customAgents.js";
import type { TerminalSession } from "./ptyHelper.js";

const logger = createLogger("sessionMode");
// How long a CLI is given to exit before the other surface takes the conversation over:
// in one direction the resume line is typed into the shell, in the other the chat's own
// process binds the same conversation. Both want the old CLI gone first.
const CLI_EXIT_MS = 1200;
// Engines whose CLI is daemon-owned, so the chat UI can drive it. Must list exactly
// the ids the web registry gives a `ui:` entry — an engine missing here is refused a
// switch, one listed without a registry entry renders as a plain terminal.
const UI_ENGINES = new Set(["claude", "codex", "opencode", "antigravity", "omp", "pi", "devin", "hermes"]);
// Whose id a session carries when status has not recorded the surface yet: only the
// chat engines resolve here, and claude is the one every host has.
const FALLBACK_ENGINE = "claude";

type ConversationRef = { agent: string; id: string };

// Clear line sequence: Esc on Windows (cmd/powershell), Ctrl+E + Ctrl+U on Unix
export const CLEAR_LINE = process.platform === "win32" ? "\x1b" : "\x05\x15";

// The conversation this terminal holds, or the one its live chat session is actually
// running when status has not caught up yet. A terminal switched into the UI records
// its conversation a beat after the click, so status is not the only place to look.
function resolveConversation(sessionId: string): ConversationRef | null {
  const conv = getConversation(sessionId);
  if (conv?.id) return conv;
  const aiSession = globalAiManager.getSession(sessionId);
  const id = aiSession?.cliSessionId || aiSession?.threadId;
  return id ? { agent: surfaceAgent(getSessionAgent(sessionId) || aiSession?.engine) || FALLBACK_ENGINE, id } : null;
}

export async function setSessionMode(sessionId: string, mode: string, { sessions, io }: { sessions?: Map<string, TerminalSession>; io?: unknown } = {}) {
  const session = sessions?.get(sessionId);
  if (!session) return { success: false, error: "Session not found" };
  if (mode !== MODE.UI && mode !== MODE.TERMINAL) return { success: false, error: "Invalid mode" };
  const conv = resolveConversation(sessionId);

  // The surface keeps a custom launcher's id; only the engine check wants the base.
  const current = surfaceAgent(getSessionAgent(sessionId) || conv?.agent || session.agent) ?? "";
  const engine = engineFromAgent(current);
  if (!engine || !UI_ENGINES.has(engine)) return { success: false, error: `${engine || "Session"} has no chat UI` };

  const agentId = mode === MODE.UI ? `${current}-ui` : current;
  if ((session.agent || conv?.agent || "").endsWith("-ui") === (mode === MODE.UI)) {
    logger.debug(`session ${sessionId} already ${mode}`);
    if (conv?.id) setConversationId(sessionId, agentId, conv.id, "resume");
    return { success: true };
  }

  logger.info(`session ${sessionId}: ${mode} ← ${conv?.agent || session.agent} ${conv?.id || "fresh"}`);
  // Set the surface first: it clears any conversation belonging to another CLI, and
  // the re-record below is what restores it — under the surface now running it.
  // The chat-tab guard in setSessionAgent ignores a detected bare claude; this switch is explicit.
  if (engine === "claude" && mode === MODE.TERMINAL) clearSessionAgent(sessionId);
  setSessionAgent(sessionId, agentId);
  session.agent = agentId;

  if (engine === "claude") {
    // Claude's chat drives the TUI in this terminal (ai/claudeTerminal.ts), so a switch only
    // moves the surface; the chat object goes, and the TUI keeps running under the new one.
    globalAiManager.destroySession(sessionId);
  } else if (mode === MODE.UI) {
    enterUi(sessionId, session);
    await new Promise((r) => setTimeout(r, 400));
  } else {
    leaveUi(sessionId, session, conv);
  }

  if (conv?.id) {
    setConversationId(sessionId, agentId, conv.id, "resume");
  }

  broadcast(io, "sessionAgentChanged", { sessionId, agent: agentId });
  return { success: true };
}

export function sendTerminalInput(sessionId: string, session: TerminalSession | null | undefined, input: string): boolean {
  if (session?.daemon && daemonClient.isConnected()) {
    // Fire-and-forget by contract: sendInput returns true/false (send() catches
    // its own write errors), and a session that died between the two exit-Tui
    // writes just yields false — nothing to reject.
    daemonClient.sendInput(sessionId, input);
    return true;
  }
  if (session?.pty) {
    session.pty.write(input);
    return true;
  }
  return false;
}

// Ctrl+C x2 into the PTY — how the TUI exits. Two separate writes, not one:
// omp's key matcher reads a whole chunk and demands exactly one byte, so a
// single "\x03\x03" write matches nothing and its TUI never exits.
function exitTui(sessionId: string, session: TerminalSession): boolean {
  const sent = sendTerminalInput(sessionId, session, "\x03");
  if (sent) setTimeout(() => sendTerminalInput(sessionId, session, "\x03"), 200);
  return sent;
}

// The chat's own CLI, which the daemon runs as a managed process. Stopping it is a
// route on the daemon, not on this agent: the process outlives an agent restart, while
// globalAiManager's registry does not — a stale map makes destroySession a silent no-op
// and leaves the CLI holding the conversation. procId is the session id (aiSession).
async function stopChatCli(sessionId: string): Promise<void> {
  globalAiManager.destroySession(sessionId);
  if (!daemonClient.isConnected()) return;
  await daemonClient.procStop(sessionId).catch(() => {});
}

// Terminal → chat UI. The TUI in the PTY holds the conversation the chat is about to
// resume, so it exits first; the shell, the tab and the session itself all stay.
function enterUi(sessionId: string, session: TerminalSession): void {
  stopChatCli(sessionId);
  if (exitTui(sessionId, session)) logger.debug(`session ${sessionId} → ui, TUI exiting`);
}

// Double-quoted so spaces survive; escape what a double-quoted string still reads.
function shellQuote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

function leaveUi(sessionId: string, session: TerminalSession, conv: ConversationRef | null): void {
  // Leaving the UI would strand a CLI process on the host holding this conversation
  // while a second one resumes it.
  // Grab the chat's dir before its CLI dies: the resume line must run there, not
  // wherever the idle shell beneath happens to sit.
  const chatCwd = globalAiManager.getSession(sessionId)?.cwd || null;
  stopChatCli(sessionId);
  const surface = surfaceAgent(conv?.agent || session.agent);
  const engine = engineFromAgent(surface);
  const line = conv?.id
    ? resumeCommand(surface, conv.id, true)
    : (agentById(surface)?.cmd || engine);
  if (!line) return;
  exitTui(sessionId, session);
  // Align the shell with the chat's dir when the two drifted apart (chat in a
  // worktree, shell at the workspace root), then hand the conversation over.
  // ponytail: `&&` is a parse error in PowerShell 5, so Windows keeps the old
  // one-line behavior; revisit when a Windows user hits a worktree drift.
  const needsCd = process.platform !== "win32" && chatCwd && session.cwd && chatCwd !== session.cwd;
  const full = needsCd ? `cd ${shellQuote(chatCwd)} && ${line}` : line;
  // Clear any leaked terminal responses or dirty chars on the prompt
  setTimeout(() => sendTerminalInput(sessionId, session, `${CLEAR_LINE}${full}\r`), CLI_EXIT_MS);
  logger.debug(`session ${sessionId} → terminal (${engine} ${conv?.id || "fresh"})`);
}
