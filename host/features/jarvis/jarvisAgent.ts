import type { ToolArguments } from "../../mcp/types.js";
import type { Content, FunctionDeclaration } from "@google/genai";
type Call = { id: string; name: string; args: ToolArguments };
type ToolResult = { callId?: string; name: string; output: unknown };
type NeutralTurn = { role: "user"; text: string } | { role: "assistant"; text: string; calls?: Call[] } | { role: "tool"; results: ToolResult[] };
type LegacyPart = { text?: string; functionResponse?: { name: string; response: unknown }; functionCall?: { name: string; args?: ToolArguments } };
type LegacyTurn = { role: string; parts?: LegacyPart[] };
type ModelResult = { text: string; calls: Call[] };
type ModelWire = (turns: NeutralTurn[]) => Promise<ModelResult>;
type ConfigPatch = { provider?: string; baseUrl?: unknown; apiKey?: unknown; model?: unknown };
type Emit = (type: string, data: Record<string, unknown>) => void;
type OpenAiDelta = { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
type OpenAiResponse = { error?: { message?: string }; choices?: { message?: OpenAiDelta; delta?: OpenAiDelta }[] };
type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: ToolArguments };
type AnthropicResponse = { error?: { message?: string }; content?: AnthropicBlock[] };
type OpenAiMessage = { role: string; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] };
type AnthropicMessage = { role: string; content: string | ({ type: string; text: string } | { type: string; id: string; name: string; input: ToolArguments } | { type: string; tool_use_id: string; content: string })[] };

// The standalone Jarvis agent: a function-calling loop with the coordinator
// tools, no CLI harness. The model call speaks one of three wire formats
// (gemini | openai | anthropic); history is stored in ONE neutral shape and
// converted per call — switching provider mid-conversation keeps the context.
// Config persists to the daemon KV: a restart must not forget the user's LLM
// setup. The API key rides along — same trust domain as the tunnel creds
// already on disk (~/.9remote), and the browser copy is plaintext anyway.
import { kvGet, kvSet } from "../terminal/ptyDaemonClient.js";
import { JARVIS_TOOLS, jarvisToolManifest } from "../../mcp/tools/jarvis/index.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("jarvis");

type AgentKv = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<unknown> };
let kv: AgentKv = { get: kvGet, set: kvSet };
export function setAgentKvForTests(next: AgentKv) { kv = next; }

const KV_KEY = "jarvis:chat";
const CONFIG_KV_KEY = "jarvis:agentConfig";
const MAX_HISTORY = 60;       // neutral turns kept (tool exchanges included)
const MAX_TOOL_LOOPS = 8;     // runaway backstop for one user turn
const TOOL_RESULT_CHARS = 4000;
const HTTP_TIMEOUT_MS = 120000;

export const JARVIS_AGENT_SYSTEM_PROMPT =
  "You are Jarvis — the conductor coordinating worker sessions (AI CLIs and terminals) on this machine. " +
  "The user chats to delegate work and ask about status. Convention: when the user asks to 'create a task/job in workspace X', " +
  "OPEN a worker session in that workspace (create_session with the workspace taken from list_fleet's workspacePath, " +
  "default engine claude), delegate via dispatch_prompt, and record a manage_kanban card for that workspace. " +
  "When woken because a worker finished or awaits approval: check with list_fleet, update the board, " +
  "report only what matters. When a worker is done and no longer needed, close_session to free its resources. " +
  "Reply briefly, in the user's language.";

export const JARVIS_AGENT_PROVIDERS = ["gemini", "openai", "anthropic"];
export const JARVIS_AGENT_DEFAULTS = {
  provider: "gemini",
  baseUrl: "",              // empty = the provider's own default
  model: "gemini-3.8-flash"
};

// Web-provided config, mirrored to the KV. Empty key = the agent answers with guidance.
let config = { ...JARVIS_AGENT_DEFAULTS, apiKey: "" };
let busy = false;
let history: NeutralTurn[] | null = null; // lazy-loaded once, then kept in sync with the KV
// Injectable so tests drive the loop without network.
let callModel: ModelWire | null = null;
let configLoaded = false;

function applyConfig({ provider, baseUrl, apiKey, model }: ConfigPatch = {}) {
  if (provider && JARVIS_AGENT_PROVIDERS.includes(provider)) config.provider = provider;
  if (baseUrl !== undefined) config.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
  if (apiKey !== undefined) config.apiKey = String(apiKey || "");
  if (model) config.model = String(model);
}

export function setAgentConfig(patch: ConfigPatch = {}) {
  applyConfig(patch);
  logger.info(`config ← web: provider=${config.provider} baseUrl="${config.baseUrl}" model=${config.model} key=${config.apiKey ? config.apiKey.slice(0, 7) + "…" : "(none)"}`);
  void kv.set(CONFIG_KV_KEY, { ...config }).catch(() => { /* daemon down: memory serves this session */ });
}

/** One-shot on agent start: bring back the config the last session had. */
export async function loadAgentConfig() {
  if (configLoaded) return true;
  configLoaded = true;
  try {
    const saved = await kv.get(CONFIG_KV_KEY);
    if (saved && typeof saved === "object") applyConfig(saved);
    logger.info(`config ← kv (restart restore): provider=${config.provider} baseUrl="${config.baseUrl}" model=${config.model} key=${config.apiKey ? "kept" : "(none)"}`);
  } catch { /* daemon down: defaults stand until the web re-sends */ }
  return true;
}

export function agentStatus() {
  return { ...config, apiKey: undefined, ready: !!config.apiKey, busy };
}

// ── History: one neutral shape, three wire formats ──
//   { role: "user",      text }
//   { role: "assistant", text, calls: [{ id, name, args }] }
//   { role: "tool",      results: [{ name, output }] }

// The first version of this agent stored Gemini parts verbatim; on load those
// become neutral so an old conversation survives a provider switch too.
export function toNeutral(turn: LegacyTurn | null | undefined): NeutralTurn | null {
  if (!turn || typeof turn !== "object") return null;
  if (turn.role === "user" && turn.parts) {
    const texts = turn.parts.filter((p) => typeof p?.text === "string" && p.text).map((p) => p.text).join("");
    const responses = turn.parts.filter((p) => p?.functionResponse);
    if (responses.length) {
      return { role: "tool", results: responses.map((p) => ({ name: p.functionResponse!.name, output: p.functionResponse!.response })) };
    }
    return texts ? { role: "user", text: texts } : null;
  }
  if (turn.role === "model" && Array.isArray(turn.parts)) {
    const text = turn.parts.filter((p) => typeof p?.text === "string" && p.text).map((p) => p.text).join("");
    const calls = turn.parts.filter((p) => p?.functionCall).map((p, i) => ({ id: `${p.functionCall!.name}-${i}`, name: p.functionCall!.name!, args: p.functionCall!.args || {} }));
    return { role: "assistant", text, calls };
  }
  return null; // already neutral shapes pass through below
}

async function loadHistory() {
  if (history) return history;
  try { history = ((await kv.get(KV_KEY)) || []) as NeutralTurn[]; } catch { history = []; }
  if (!Array.isArray(history)) history = [];
  history = (history as (NeutralTurn & { parts?: LegacyPart[] })[]).map((turn) => {
    // Neutral already? (has our own role markers, not Gemini's parts)
    if (turn && !turn.parts && (turn.role === "user" || turn.role === "assistant" || turn.role === "tool")) return turn;
    return toNeutral(turn as LegacyTurn);
  }).filter((turn): turn is NeutralTurn => Boolean(turn));
  return history;
}

async function saveHistory() {
  try { await kv.set(KV_KEY, history!.slice(-MAX_HISTORY)); } catch { /* daemon down: memory still serves */ }
}

function declarations() {
  return jarvisToolManifest().map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema }));
}

// ── gemini ──
export function toGeminiContents(turns: NeutralTurn[]): Content[] {
  return turns.map((turn) => {
    if (turn.role === "user") return { role: "user", parts: [{ text: turn.text }] };
    if (turn.role === "tool") {
      return { role: "user", parts: turn.results.map((r) => ({ functionResponse: { name: r.name, response: r.output as Record<string, unknown> } })) };
    }
    return {
      role: "model",
      parts: [
        ...(turn.text ? [{ text: turn.text }] : []),
        ...(turn.calls || []).map((c) => ({ functionCall: { name: c.name, args: c.args } }))
      ]
    };
  });
}

async function callGemini(turns: NeutralTurn[]): Promise<ModelResult> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ ...(config.baseUrl ? { httpOptions: { baseUrl: config.baseUrl } } : {}), apiKey: config.apiKey });
  const res = await ai.models.generateContent({
    model: config.model,
    contents: toGeminiContents(turns),
    config: {
      systemInstruction: JARVIS_AGENT_SYSTEM_PROMPT,
      tools: [{ functionDeclarations: declarations() as FunctionDeclaration[] }]
    }
  });
  const parts = res?.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.filter((p) => typeof p?.text === "string" && p.text).map((p) => p.text).join(""),
    calls: parts.filter((p) => p?.functionCall).map((p, i) => ({ id: `${p.functionCall!.name}-${i}`, name: p.functionCall!.name!, args: p.functionCall!.args || {} }))
  };
}

// ── openai-compatible (OpenRouter, OpenAI, groq, ollama, ...) ──
export function toOpenAiMessages(turns: NeutralTurn[]) {
  const messages: OpenAiMessage[] = [{ role: "system", content: JARVIS_AGENT_SYSTEM_PROMPT }];
  for (const turn of turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "assistant") {
      messages.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.calls?.length ? {
          tool_calls: turn.calls.map((c) => ({
            id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
          }))
        } : {})
      });
    } else if (turn.role === "tool") {
      for (const r of turn.results) {
        messages.push({ role: "tool", tool_call_id: r.callId || r.name, content: JSON.stringify(r.output) });
      }
    }
  }
  return messages;
}

// Stream deltas arrive fragmented: content in pieces, each tool_call split so
// id/name land in the first fragment and arguments trickle as string chunks.
// Merge by the fragment's own index; result() gives the wire-call shape.
export function openAiStreamAccumulator() {
  let text = "";
  const calls: { id: string; name: string; args: string }[] = [];
  return {
    push(delta: OpenAiDelta | null | undefined) {
      if (typeof delta?.content === "string") text += delta.content;
      for (const d of delta?.tool_calls || []) {
        const i = d.index ?? 0;
        calls[i] = calls[i] || { id: "", name: "", args: "" };
        if (d.id) calls[i].id = d.id;
        if (d.function?.name) calls[i].name += d.function.name;
        if (typeof d.function?.arguments === "string") calls[i].args += d.function.arguments;
      }
    },
    result() {
      return { text, calls: calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, args: safeJson(c.args) })) };
    }
  };
}

export async function callOpenAi(turns: NeutralTurn[]): Promise<ModelResult> {
  const base = config.baseUrl || "https://openrouter.ai/api/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages: toOpenAiMessages(turns),
      tools: declarations().map((d) => ({ type: "function", function: d }))
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as OpenAiResponse | null;
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }
  // Gateways split here: some stream SSE whatever the flag says, some ignore
  // stream:true and return one JSON body — consume whichever arrives.
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const msg = ((await res.json()) as OpenAiResponse)?.choices?.[0]?.message || {};
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      calls: (msg.tool_calls || []).map((c) => ({ id: c.id!, name: c.function?.name || "", args: safeJson(c.function?.arguments) }))
    };
  }
  const acc = openAiStreamAccumulator();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return acc.result();
      let evt: OpenAiResponse;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.error) throw new Error(evt.error?.message || "stream error");
      acc.push(evt.choices?.[0]?.delta);
    }
  }
  return acc.result(); // stream ended without [DONE] — take what arrived
}

// ── anthropic ──
export function toAnthropicMessages(turns: NeutralTurn[]) {
  const messages: AnthropicMessage[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [
          ...(turn.text ? [{ type: "text", text: turn.text }] : []),
          ...(turn.calls || []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))
        ]
      });
    } else if (turn.role === "tool") {
      messages.push({
        role: "user",
        content: turn.results.map((r) => ({ type: "tool_result", tool_use_id: r.callId || r.name, content: JSON.stringify(r.output) }))
      });
    }
  }
  return messages;
}

async function callAnthropic(turns: NeutralTurn[]): Promise<ModelResult> {
  const base = config.baseUrl || "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: JARVIS_AGENT_SYSTEM_PROMPT,
      messages: toAnthropicMessages(turns),
      tools: declarations()
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  const body = await res.json() as AnthropicResponse;
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  const blocks = body?.content || [];
  return {
    text: blocks.filter((b: { type: string; }) => b.type === "text").map((b) => b.text).join(""),
    calls: blocks.filter((b: { type: string; }) => b.type === "tool_use").map((b) => ({ id: b.id!, name: b.name!, args: b.input || {} }))
  };
}

function safeJson(value: unknown): ToolArguments {
  if (typeof value !== "string") return (value || {}) as ToolArguments;
  try { return JSON.parse(value); } catch { return {}; }
}

async function runTool(name: string, args: ToolArguments) {
  const tool = JARVIS_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    const res = await tool.run(args || {}, { sessionId: "jarvis-agent" });
    if ((res as { error?: unknown } | null)?.error) return { error: (res as { error: unknown }).error };
    return typeof res === "string" ? { result: res.slice(0, TOOL_RESULT_CHARS) } : res;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * One user turn: append the message, loop tool calls until a final answer.
 * Every step is reported through `emit` as it happens; returns the final text.
 */
export async function jarvisTurn(userText: unknown, emit?: Emit) {
  if (busy) return { error: "a turn is already running — wait for it to finish" };
  if (!config.apiKey) return { error: "no API key — add one in Settings → Jarvis" };
  busy = true;
  try {
    const events = emit || (() => {});
    const turns = await loadHistory();
    turns.push({ role: "user", text: String(userText || "") });
    const wire = callModel
      || (config.provider === "openai" ? callOpenAi
        : config.provider === "anthropic" ? callAnthropic
        : callGemini);
    logger.info(`turn: provider=${config.provider} baseUrl="${config.baseUrl}" model=${config.model} history=${turns.length}`);
    let answer = "";

    for (let hop = 0; hop < MAX_TOOL_LOOPS; hop++) {
      const { text, calls } = await wire(turns);
      turns.push({ role: "assistant", text, calls });
      if (!calls.length) {
        answer = text || "(no answer)";
        break;
      }
      // Run every call of this hop; the ids ride back so openai/anthropic can
      // correlate each result with its call (gemini keys by name).
      const results = [];
      for (const call of calls) {
        events("tool", { name: call.name, args: call.args || {} });
        const output = await runTool(call.name, call.args);
        const shown = JSON.stringify(output).slice(0, TOOL_RESULT_CHARS);
        events("toolResult", { name: call.name, result: shown });
        results.push({ callId: call.id, name: call.name, output });
      }
      turns.push({ role: "tool", results });
    }
    if (!answer) answer = "tool-call loop limit reached — stopped for safety, ask me again to continue";

    events("assistant", { text: answer });
    await saveHistory();
    return { text: answer };
  } catch (e) {
    logger.error(`agent turn failed: ${(e as Error).message}`);
    return { error: `${config.provider} error: ${(e as Error).message}` };
  } finally {
    busy = false;
  }
}

/** The wake door — jarvisWake hands worker-finished notes in as user turns. */
export async function jarvisWakeTurn(text: string) {
  if (!config.apiKey || busy) return { skipped: true };
  return await jarvisTurn(text, () => {});
}

export async function chatHistory() {
  return (await loadHistory()).slice(-MAX_HISTORY);
}

export function resetAgentForTests({ generate: fakeWire = null }: { generate?: ModelWire | null } = {}) {
  config = { ...JARVIS_AGENT_DEFAULTS, apiKey: "" };
  busy = false;
  history = [];
  callModel = fakeWire;
  configLoaded = false;
}
