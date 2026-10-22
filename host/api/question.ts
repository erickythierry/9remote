/**
 * Gates a claude chat answers for the TUI in its terminal (localhost-only): AskUserQuestion
 * (PreToolUse) and permission dialogs (PermissionRequest). The hook posts and holds; the
 * chat's answer becomes the hook's output, so the TUI never opens its own dialog. No answer
 * (no chat, skipped, timed out): an empty body leaves the TUI to ask as usual.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonErr } from "../lib/router.js";
import { globalAiManager } from "../features/ai/aiManager.js";
import { PERMISSION_GATE_PREFIX } from "../features/ai/claudeTerminal.js";
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
  const toolName = String(hook?.tool_name || "");
  const input = hook?.tool_input || {};
  if (!terminal || !toolName) return res.end();

  if (hook.hook_event_name === "PermissionRequest") {
    // AskUserQuestion is answered by the PreToolUse gate; its permission step is not a question to the user.
    if (toolName === "AskUserQuestion") return res.end();
    const decision = await terminal.ask(`${PERMISSION_GATE_PREFIX}${Date.now()}`, toolName, input, CLAUDE_QUESTION_WAIT_MS);
    if (!decision) return res.end();
    return reply(res, {
      hookEventName: "PermissionRequest",
      decision: decision.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: decision.message || "Denied from the chat." }
    });
  }

  if (toolName !== "AskUserQuestion" || !Array.isArray(input.questions) || !input.questions.length) return res.end();
  const answers = await terminal.ask(String(hook.tool_use_id || `q-${Date.now()}`), toolName, { questions: input.questions }, CLAUDE_QUESTION_WAIT_MS);
  if (!answers) return res.end();
  reply(res, { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input, answers } });
}
