/**
 * Gates a claude chat answers for the TUI in its terminal (localhost-only). AskUserQuestion
 * (PreToolUse) is not held: the TUI shows its dialog and the chat mirrors it (claudeTerminal.ts).
 * Permission dialogs (PermissionRequest) and elicitations hold, and the chat's answer becomes
 * the hook's output. No answer (no chat, skipped, timed out): an empty body leaves the TUI to ask.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonErr } from "../lib/router.js";
import { globalAiManager } from "../features/ai/aiManager.js";
import { PERMISSION_GATE_PREFIX, openQuestions } from "../features/ai/claudeTerminal.js";
import { getSessionAgent } from "../features/terminal/statusManager.js";
import { isTuiChatSurface } from "../features/terminal/conversationModes.js";
import { CLAUDE_QUESTION_WAIT_MS } from "../features/ai/constants.js";

const MAX_BODY = 256 * 1024;

function reply(res: ServerResponse, hookSpecificOutput: Record<string, unknown>) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ hookSpecificOutput }));
}

export async function handleQuestionPost(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return jsonErr(res, 413, "Too large");
  }
  let hook: any;
  try { hook = JSON.parse(body || "{}"); } catch { return jsonErr(res, 400, "Invalid JSON"); }
  const sessionId = new URL(req.url || "", "http://x").searchParams.get("sessionId") || "";
  const terminal = globalAiManager.getSession(sessionId)?.terminal;

  // The TUI opens its own dialog at once; the chat mirrors it and answers by typing into it.
  if (hook.hook_event_name === "PreToolUse") {
    const input = hook?.tool_input || {};
    const id = String(hook.tool_use_id || "");
    if (hook.tool_name !== "AskUserQuestion" || !id || !Array.isArray(input.questions) || !input.questions.length) return res.end();
    if (!openQuestions.has(sessionId)) openQuestions.set(sessionId, new Map());
    openQuestions.get(sessionId)!.set(id, { questions: input.questions });
    terminal?.mirrorQuestion(id, { questions: input.questions });
    return res.end();
  }

  // In terminal mode no chat card is on screen, so a held gate would freeze the TUI.
  if (!terminal || !isTuiChatSurface(getSessionAgent(sessionId))) return res.end();

  if (hook.hook_event_name === "Elicitation") {
    const serverName = String(hook?.mcp_server_name || "mcp");
    const result = await terminal.ask(
      `elicitation-${Date.now()}`,
      `MCP: ${serverName}`,
      { serverName, schema: hook?.schema, message: hook?.message },
      CLAUDE_QUESTION_WAIT_MS
    );
    if (!result) return res.end();
    return reply(res, {
      hookEventName: "ElicitationResult",
      result: typeof result === "object" ? result : { value: result }
    });
  }

  const toolName = String(hook?.tool_name || "");
  const input = hook?.tool_input || {};
  if (!toolName) return res.end();

  if (hook.hook_event_name === "PermissionRequest") {
    // AskUserQuestion is answered by the PreToolUse gate; its permission step is not a question to the user.
    if (toolName === "AskUserQuestion") return res.end();
    const decision = await terminal.ask(`${PERMISSION_GATE_PREFIX}${Date.now()}`, toolName, input, CLAUDE_QUESTION_WAIT_MS);
    if (!decision) return res.end();
    const isAllow = decision.behavior === "allow";
    const updatedInput = decision.updatedInput || input;
    return reply(res, {
      hookEventName: "PermissionRequest",
      decision: isAllow
        ? { behavior: "allow", ...(decision.updatedInput ? { updatedInput } : {}) }
        : { behavior: "deny", message: decision.message || "Denied from the chat." }
    });
  }

}
