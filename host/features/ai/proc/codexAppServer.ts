import { JsonRpcClient, type ProcLike } from "./jsonRpcClient.js";
import { sandboxPolicyFor, approvalPolicyFor, collaborationModeFor, BLOCKED_TEXT_RE, MODE_LABELS, nextModeUp } from "../codexSettings.js";
import { elicitationQuestions } from "../elicitation.js";
import { createLogger } from "../../../lib/logger.js";

const logger = createLogger("codex-app-server");

const ACTION_NAMES: Record<string, string> = { read: "read", listFiles: "list_files", search: "search" };

const REQUEST_TIMEOUT_MS = 15000;

const ALREADY_ROUTED_OR_STREAMING = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "command/exec/outputDelta",
  "process/outputDelta",
  "fs/changed",
  "thread/tokenUsage/updated",
  "turn/diff/updated"
]);

export interface CodexAppServerOptions {
  proc: ProcLike;
  cwd?: string;
  onEvent?: (event: string, data?: any) => void;
  onInterruptSettled?: (() => void) | null;
  threadId?: string | null;
  model?: string;
  mode?: string | null;
  sandbox?: string | null;
  approvalPolicy?: any;
  effort?: string | null;
  personality?: string | null;
  settings?: any;
}

export class CodexAppServer {
  cwd: string;
  onEvent?: (event: string, data?: any) => void;
  onInterruptSettled?: (() => void) | null;
  threadId: string | null;
  turnId: string | null;
  private _interrupted: boolean;
  threadName: string;
  model: string;
  effort: string;
  personality: string;
  planMode: boolean;
  planEffort: string;
  permissionMode: string | null;
  sandboxName: string | null;
  networkAccess: boolean;
  addDirs: string[];
  settings: any;
  pendingSettings: Record<string, any>;
  rpc: JsonRpcClient;
  isTurnRunning: boolean;
  closed: boolean;
  gates: Map<string, any>;
  planText: Map<string, string>;

  constructor({ proc, cwd, onEvent, onInterruptSettled = null, threadId = null, model = "", mode = null, sandbox = null, approvalPolicy = null, effort = null, personality = null, settings = null }: CodexAppServerOptions) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.onInterruptSettled = onInterruptSettled;
    this.threadId = threadId || null;
    this.turnId = null;
    this._interrupted = false;
    this.threadName = "";
    this.model = model || "";
    this.effort = effort || "";
    this.personality = personality || "";
    this.planMode = false;
    this.planEffort = "";
    this.permissionMode = mode || null;
    this.sandboxName = sandbox || null;
    this.networkAccess = false;
    this.addDirs = [];
    this.settings = settings || {
      sandboxPolicy: sandboxPolicyFor({ mode: this.permissionMode || undefined, sandbox: this.sandboxName || undefined }),
      approvalPolicy: approvalPolicy || approvalPolicyFor({ mode: this.permissionMode || undefined })
    };
    this.pendingSettings = {};

    this.rpc = new JsonRpcClient(proc, {
      onMessage: (msg: any) => {
        if (ALREADY_ROUTED_OR_STREAMING.has(msg.method)) return;
        if (!this._mine(msg.params)) return;
        this.onEvent?.("cli_event", { type: msg.method || "", subtype: "", record: msg.params || {} });
      }
    });
    this.isTurnRunning = false;
    this.closed = false;
    // Answers must preserve raw RequestId type (string | number) on the wire.
    this.gates = new Map();
    this.planText = new Map();
    this._wire();
  }

  private _wire() {
    const rpc = this.rpc;

    rpc.on("item/reasoning/summaryTextDelta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.onEvent?.("thinking", { text: p.delta || "" });
    });
    rpc.on("item/reasoning/textDelta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.onEvent?.("thinking", { text: p.delta || "" });
    });

    rpc.on("item/agentMessage/delta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.onEvent?.("delta", { text: p.delta || "" });
    });

    rpc.on("item/plan/delta", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = true;
      this.planText.set(p.itemId, (this.planText.get(p.itemId) || "") + (p.delta || ""));
      this.onEvent?.("tool_start", {
        id: p.itemId, name: "update_plan", status: "running",
        input: { plan: this.planText.get(p.itemId) }
      });
    });

    rpc.on("item/started", (p) => {
      if (!this._mine(p)) return;
      const item = p.item || {};
      if (item.type === "reasoning") return;
      this.isTurnRunning = true;
      for (const ev of this._itemEvents(item, "inProgress")) this._emit(ev);
    });

    rpc.on("item/completed", (p) => {
      if (!this._mine(p)) return;
      const item = p.item || {};
      if (item.type === "reasoning") return;
      if (item.type === "agentMessage" && item.text && BLOCKED_TEXT_RE.test(item.text)) {
        const next = nextModeUp(this.permissionMode || "");
        if (next) {
          this.onEvent?.("blocked", {
            engine: "codex",
            message: item.text,
            escalate: { mode: next, label: MODE_LABELS[next] }
          });
        }
      }
      for (const ev of this._itemEvents(item, item.status || "completed")) this._emit(ev);
    });

    rpc.on("thread/tokenUsage/updated", (p) => {
      const last = p.tokenUsage?.last || {};
      const total = p.tokenUsage?.total || {};
      this.onEvent?.("stats", {
        inputTokens: last.inputTokens || 0,
        outputTokens: last.outputTokens || 0,
        cachedTokens: last.cachedInputTokens || 0,
        reasoningTokens: last.reasoningOutputTokens || 0,
        // The thread's running total, assigned: this notification can fire several times a turn.
        sessionInputTokens: total.inputTokens || 0,
        sessionCachedTokens: total.cachedInputTokens || 0,
        sessionOutputTokens: total.outputTokens || 0,
        ...(p.tokenUsage?.modelContextWindow ? { contextWindow: p.tokenUsage.modelContextWindow } : {})
      });
    });

    rpc.on("turn/started", (p) => {
      if (!this._mine(p)) return;
      if (p.turn?.id) this.turnId = p.turn.id;
    });

    rpc.on("turn/completed", (p) => {
      if (!this._mine(p)) return;
      this.isTurnRunning = false;
      this.turnId = null;
      this.gates.clear();
      if (this._interrupted) {
        this._interrupted = false;
        this.onInterruptSettled?.();
        return;
      }
      const turn = p.turn || {};
      if (turn.status === "failed") {
        this.onEvent?.("error", { message: turn.error?.message || "Codex reported the turn as failed" });
      }
      this.onEvent?.("turn_complete", { stats: {} });
    });

    rpc.on("turn/plan/updated", (p) => {
      if (!this._mine(p)) return;
      const todos = (p.plan || []).map((s: any) => ({ content: s.step || "", status: s.status || "pending" }));
      if (!todos.length) return;
      this.onEvent?.("tool_start", {
        id: `plan-${p.turnId || "turn"}`,
        name: "todo_list",
        status: "running",
        input: { todos, ...(p.explanation ? { explanation: p.explanation } : null) }
      });
    });

    rpc.on("execCommandApproval", (p, id) => this._askPermission(p, id, "exec"));
    rpc.on("applyPatchApproval", (p, id) => this._askPermission(p, id, "patch"));
    rpc.on("item/commandExecution/requestApproval", (p, id) => this._askPermission(p, id, "exec"));
    rpc.on("item/fileChange/requestApproval", (p, id) => this._askPermission(p, id, "patch"));
    rpc.on("item/tool/requestUserInput", (p, id) => this._askQuestion(p, id));
    rpc.on("item/permissions/requestApproval", (p, id) => this._askPermissionGrant(p, id));
    rpc.on("mcpServer/elicitation/request", (p, id) => this._askElicitation(p, id));

    rpc.on("thread/name/updated", (p) => {
      if (!this._mine(p)) return;
      const name = String(p.threadName || "").trim();
      if (!name) return;
      this.threadName = name;
      this.onEvent?.("init", { threadId: this.threadId, threadName: name });
    });

    rpc.on("serverRequest/resolved", (p) => {
      if (!this._mine(p)) return;
      const requestId = String(p.requestId);
      if (!this.gates.has(requestId)) return;
      this.onEvent?.("permission_resolved", { requestId, behavior: "dismissed" });
    });

    rpc.onExit((info) => this._handleExit(info));
  }

  private _mine(params: any): boolean {
    return !this.threadId || !params?.threadId || params.threadId === this.threadId;
  }

  private _emit(ev: any) { this.onEvent?.(ev.event, ev.data); }

  private _askPermission(params: any, rpcId: any, kind: "patch" | "exec") {
    const command = (Array.isArray(params.command) ? params.command : [params.command]).filter((c: any) => typeof c === "string").join(" ");
    this.isTurnRunning = true;
    const tool = kind === "patch" ? "apply_patch" : "command";
    const input = { ...params, command, path: params.path || "" };
    this.gates.set(String(rpcId), { requestId: String(rpcId), rawId: rpcId, toolName: tool, input });
    this.onEvent?.("permission_request", { requestId: String(rpcId), tool, input, type: "permission" });
  }

  private _askQuestion(params: any, rpcId: any) {
    this.isTurnRunning = true;
    const questions = params.questions || [];
    this.gates.set(String(rpcId), { requestId: String(rpcId), rawId: rpcId, toolName: "request_user_input", input: { questions } });
    this.onEvent?.("permission_request", {
      requestId: String(rpcId), tool: "AskUserQuestion", input: { questions }, type: "question"
    });
  }

  resolveQuestion(requestId: any, answers: Record<string, any> = {}): boolean {
    if (!requestId) return false;
    const gate = this.gates.get(String(requestId));
    if (!this.gates.delete(String(requestId))) return false;
    const byText = new Map((gate?.input?.questions || []).map((q: any) => [q.question, q.id]));
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(answers || {})) {
      const id = String(byText.get(key) || key);
      if (!byText.size || [...byText.values()].includes(id)) out[id] = { answers: [String(value)] };
    }
    const rawId = gate?.rawId ?? requestId;
    if (gate?.input?.kind === "elicitation") this.rpc.respond(rawId, {
      action: "accept",
      content: Object.fromEntries(Object.entries(out).map(([id, a]) => [id, a.answers[0]])),
      _meta: null
    });
    else this.rpc.respond(rawId, { answers: out });
    return true;
  }

  private _askElicitation(params: any, rpcId: any) {
    this.isTurnRunning = true;
    const questions = elicitationQuestions(params);
    const input = {
      kind: "elicitation",
      questions,
      message: params.message || "",
      serverName: params.serverName || ""
    };
    this.gates.set(String(rpcId), { requestId: String(rpcId), rawId: rpcId, toolName: "AskUserQuestion", input });
    this.onEvent?.("permission_request", {
      requestId: String(rpcId), tool: "AskUserQuestion", input, type: "question"
    });
  }

  private _askPermissionGrant(params: any, rpcId: any) {
    this.isTurnRunning = true;
    const input = {
      kind: "permission_grant",
      reason: params.reason || "",
      permissions: params.permissions || {},
      cwd: params.cwd || this.cwd
    };
    this.gates.set(String(rpcId), { requestId: String(rpcId), rawId: rpcId, toolName: "request_permissions", input });
    this.onEvent?.("permission_request", { requestId: String(rpcId), tool: "request_permissions", input, type: "permission" });
  }

  private _itemEvents(item: any, status: string): any[] {
    const id = item.id;
    const done = status === "completed" || status === "failed" || status === "declined" || status === "interrupted";
    const out: any[] = [];

    if (item.type === "commandExecution") {
      const actions = (item.commandActions || []).filter((a: any) => a?.command);
      const name = ACTION_NAMES[actions[0]?.type] || "command";
      const command = actions.length ? actions.map((a: any) => a.command).join("; ") : (item.command || "");
      const first = actions[0] || {};
      out.push({
        event: "tool_start",
        data: {
          id, name, status: done ? "done" : "running",
          input: { command, ...(first.path ? { path: first.path, file_path: first.path } : {}), ...(first.query ? { query: first.query } : {}) }
        }
      });
      if (!done) return out;
      const output = item.aggregatedOutput ?? "";
      const failed = status === "failed" || status === "declined" || (item.exitCode ?? 0) !== 0;
      const reason = status === "declined" ? "Command declined" : `${output}\n(exit ${item.exitCode})`.trim();
      out.push({
        event: "tool_result",
        data: { id, name, output: failed ? "" : output, error: failed ? reason : "", status: failed ? "error" : "done" }
      });
      return out;
    }

    if (item.type === "fileChange") {
      // Only a FAILED patch opens the card: success draws its diffs (a card beside them
      // would duplicate every file), but without one a failed result lands on nothing
      // and a patch that failed to apply looks like one that landed.
      if (status === "failed") out.push({ event: "tool_start", data: { id, name: "file_change", status: "running", input: {} } });
      for (const change of item.changes || []) {
        out.push({ event: "diff", data: { file: change.path || "", patch: change.diff || "", content: "" } });
      }
      out.push({
        event: "tool_result",
        data: { id, name: "file_change", output: "", error: status === "failed" ? "Patch failed to apply" : "", status: status === "failed" ? "error" : "done" }
      });
      return out;
    }

    if (item.type === "mcpToolCall") {
      out.push({ event: "tool_start", data: { id, name: item.tool || "mcp_tool_call", status: done ? "done" : "running", input: item.arguments || {} } });
      if (done) {
        // The item's own status, not a hardcoded success — the app-server marks a failed call "failed".
        const failed = item.status === "failed";
        out.push({ event: "tool_result", data: { id, name: item.tool || "mcp_tool_call", output: failed ? "" : (typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? "")), error: failed ? String(item.error?.message || "The MCP tool call failed.") : "", status: failed ? "error" : "done" } });
      }
      return out;
    }

    if (item.type === "webSearch") {
      out.push({ event: "tool_start", data: { id, name: "web_search", status: done ? "done" : "running", input: { query: item.query || "" } } });
      if (done) out.push({ event: "tool_result", data: { id, name: "web_search", output: item.query || "", error: "", status: "done" } });
      return out;
    }

    if (item.type === "plan") {
      const text = item.text || this.planText.get(id) || "";
      if (done) this.planText.delete(id);
      out.push({ event: "tool_start", data: { id, name: "update_plan", status: done ? "done" : "running", input: { plan: text } } });
      if (done) out.push({ event: "tool_result", data: { id, name: "update_plan", output: "", error: "", status: "done" } });
      return out;
    }

    if (item.type === "imageView") {
      out.push({
        event: "tool_start",
        data: { id, name: "view_image", status: done ? "done" : "running", input: { path: item.path || "", file_path: item.path || "" } }
      });
      if (done) out.push({ event: "tool_result", data: { id, name: "view_image", output: "", error: "", status: "done" } });
      return out;
    }

    if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
      out.push({
        event: "tool_start",
        data: { id, name: item.type, status: "done", input: { review: item.review || "" } }
      });
      out.push({
        event: "tool_result",
        data: { id, name: item.type, output: "", error: "", status: "done" }
      });
      return out;
    }

    if (item.type === "collabAgentToolCall") {
      const name = item.tool ? item.tool.replace(/[A-Z]/g, (c: string) => `_${c.toLowerCase()}`) : "agent";
      out.push({
        event: "tool_start",
        data: { id, name, status: done ? "done" : "running", input: item.prompt ? { subagent_type: item.tool, prompt: item.prompt } : {} }
      });
      if (!done) return out;
      const errored = Object.values<any>(item.agentsStates || {}).find((s) => (s?.status || s) === "errored");
      const failed = status === "failed" || status === "interrupted" || Boolean(errored);
      out.push({
        event: "tool_result",
        data: {
          id, name, status: failed ? "error" : "done", output: "",
          error: failed ? (errored?.message || `Codex reported ${item.tool} as ${status}`) : ""
        }
      });
      return out;
    }

    if (item.type === "imageGeneration") {
      const saved = item.savedPath || "";
      out.push({
        event: "tool_start",
        data: { id, name: "image_generation", status: done ? "done" : "running", input: { path: saved, file_path: saved, prompt: item.revisedPrompt || "" } }
      });
      if (!done) return out;
      const failed = status === "failed" || Boolean(item.failure);
      out.push({
        event: "tool_result",
        data: { id, name: "image_generation", output: failed ? "" : saved, error: failed ? (item.failure?.message || "Image generation failed") : "", status: failed ? "error" : "done" }
      });
      return out;
    }

    if (item.type === "sleep") {
      out.push({
        event: "tool_start",
        data: { id, name: "sleep", status: "done", input: { duration_ms: item.durationMs ?? 0 } }
      });
      out.push({ event: "tool_result", data: { id, name: "sleep", output: "", error: "", status: "done" } });
      return out;
    }

    if (item.type === "contextCompaction") {
      if (!done) return out;
      out.push({ event: "cli_event", data: { type: "thread/compacted", subtype: "compacted", record: { id } } });
      return out;
    }

    if (item.type === "agentMessage" || item.type === "userMessage") return out;
    if (done) out.push({ event: "cli_event", data: { type: item.type || "", subtype: status || "", record: item } });
    return out;
  }

  private _handleExit(info: any) {
    if (this.closed) return;
    this.isTurnRunning = false;
    this.gates.clear();
    this.onEvent?.("error", { message: `Codex app-server exited (code ${info?.code ?? "?"})` });
    // isError, or the status channel reads this exit as a clean finish and the phone
    // is told the agent finished its turn while the process was dying.
    this.onEvent?.("turn_complete", { stats: {}, isError: true, result: "", subtype: "exit" });
  }

  async start(): Promise<string | null> {
    // experimentalApi is required for thread/settings/update and collaborationMode/list.
    await this.rpc.request("initialize", {
      clientInfo: { name: "9remote", title: "9Remote", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }, { timeoutMs: REQUEST_TIMEOUT_MS });

    const params = {
      cwd: this.cwd,
      sandboxPolicy: this.settings.sandboxPolicy,
      approvalPolicy: this.settings.approvalPolicy,
      collaborationMode: this.settings.collaborationMode || collaborationModeFor({ planMode: this.planMode, model: this.model, effort: this.effort, planEffort: this.planEffort }),
      ...(this.model ? { model: this.model } : {}),
      ...(this.personality ? { personality: this.personality } : {})
    };

    const res = this.threadId
      ? await this.rpc.request("thread/resume", { ...params, threadId: this.threadId }, { timeoutMs: REQUEST_TIMEOUT_MS })
      : await this.rpc.request("thread/start", params, { timeoutMs: REQUEST_TIMEOUT_MS });

    this.threadId = res?.thread?.id || this.threadId;
    const name = String(res?.thread?.name || "").trim();
    if (name) this.threadName = name;

    const held = this.pendingSettings;
    this.pendingSettings = {};
    if (Object.keys(held).length) await this.updateSettings(held);

    return this.threadId;
  }

  // The server's own rename; it answers and emits thread/name/updated, which the
  // listener above folds into threadTitle — same path as a rename typed in the TUI.
  async setName(name: string): Promise<boolean> {
    if (!this.threadId) return false;
    await this.rpc.request("thread/name/set", { threadId: this.threadId, name }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return true;
  }

  async updateSettings(patch: Record<string, any> = {}): Promise<boolean> {
    if (!this.threadId) {
      Object.assign(this.pendingSettings, patch);
      return false;
    }
    await this.rpc.request("thread/settings/update", { threadId: this.threadId, ...patch }, { timeoutMs: REQUEST_TIMEOUT_MS });
    return true;
  }

  applyOptions(opts: Record<string, any> = {}): Record<string, any> {
    if (opts.networkAccess !== undefined) this.networkAccess = Boolean(opts.networkAccess);
    if (opts.addDirs !== undefined) this.addDirs = (opts.addDirs || []).filter((d: any) => typeof d === "string" && d);

    if (opts.mode !== undefined || opts.networkAccess !== undefined || opts.addDirs !== undefined) {
      if (opts.mode !== undefined) this.permissionMode = opts.mode;
      this.settings.sandboxPolicy = sandboxPolicyFor({
        mode: this.permissionMode || undefined,
        sandbox: this.sandboxName || undefined,
        networkAccess: this.networkAccess,
        addDirs: this.addDirs
      });
      this.settings.approvalPolicy = approvalPolicyFor({ mode: this.permissionMode || undefined });
    }
    if (opts.planMode !== undefined) this.planMode = Boolean(opts.planMode);
    if (opts.planEffort !== undefined) this.planEffort = opts.planEffort || "";
    if (opts.model !== undefined) this.model = opts.model || "";
    if (opts.effort !== undefined) this.effort = opts.effort || "";
    if (opts.personality !== undefined) this.personality = opts.personality || "";

    const collaborationMode = collaborationModeFor({
      planMode: this.planMode, model: this.model, effort: this.effort, planEffort: this.planEffort
    });
    const changed: Record<string, any> = { sandboxPolicy: this.settings.sandboxPolicy, approvalPolicy: this.settings.approvalPolicy, collaborationMode };
    if (this.model) changed.model = this.model;
    if (this.effort) changed.effort = this.effort;
    if (this.personality) changed.personality = this.personality;
    this.settings.collaborationMode = collaborationMode;
    return changed;
  }

  private _turnInput(prompt: any, attachments: any[] = []): any[] {
    const text = String(prompt ?? "");
    const input: any[] = [];
    const others: string[] = [];
    for (const a of attachments || []) {
      if (!a?.path) continue;
      if (a.kind === "image") input.push({ type: "localImage", path: a.path });
      else others.push(a.path);
    }
    const body = [text, ...others.map((p) => `@${p}`)].filter(Boolean).join("\n");
    if (body || !input.length) input.unshift({ type: "text", text: body, text_elements: [] });
    return input;
  }

  sendPrompt(prompt: any, attachments: any[] = []): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex app-server has been closed"));
    if (this.isTurnRunning) return Promise.reject(new Error("Codex turn is already running."));
    this.isTurnRunning = true;
    if (String(prompt).trim() === "/review") {
      return this.rpc.request("review/start", {
        threadId: this.threadId,
        target: { type: "uncommittedChanges" }
      });
    }
    return this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: this._turnInput(prompt, attachments),
      ...this._turnOverrides()
    }).then((res: any) => {
      if (res?.turn?.id) this.turnId = res.turn.id;
      return res;
    });
  }

  private _turnOverrides(): Record<string, any> {
    const out: Record<string, any> = {};
    if (this.settings.sandboxPolicy) out.sandboxPolicy = this.settings.sandboxPolicy;
    if (this.settings.approvalPolicy) out.approvalPolicy = this.settings.approvalPolicy;
    if (this.model) out.model = this.model;
    if (this.effort) out.effort = this.effort;
    if (this.personality) out.personality = this.personality;
    return out;
  }

  get interrupting(): boolean {
    return Boolean(this._interrupted);
  }

  interrupt(): boolean {
    if (!this.threadId || !this.turnId || this.closed) return false;
    this._interrupted = true;
    this.rpc
      .request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, { timeoutMs: REQUEST_TIMEOUT_MS })
      .catch((e: Error) => {
        this._interrupted = false;
        this.onInterruptSettled?.();
        logger.warn(`[codex] turn/interrupt refused: ${e.message} (thread=${this.threadId} turn=${this.turnId})`);
      });
    return true;
  }

  resolvePermission(requestId: any, behavior: string, message: string = ""): boolean {
    if (!requestId) return false;
    const gate = this.gates.get(String(requestId));
    if (!this.gates.delete(String(requestId))) return false;
    // A question gate has no allow/deny of its own: a skip is the answer sheet returned
    // empty — the same wire resolveQuestion speaks. `decision` is the approval shape
    // and the server refuses it here.
    if (gate?.toolName === "request_user_input") {
      this.rpc.respond(gate?.rawId ?? requestId, { answers: {} });
      return true;
    }
    const answer = gate?.input?.kind === "permission_grant"
      ? (behavior === "allow"
        ? { permissions: gate.input.permissions || {}, scope: "turn" }
        : { permissions: {}, scope: "turn" })
      : (behavior === "allow" ? { decision: "accept" } : { decision: "decline" });
    this.rpc.respond(gate?.rawId ?? requestId, answer);
    return true;
  }

  async stop() {
    this.closed = true;
    this.isTurnRunning = false;
    this.rpc.close();
  }

  detach() {
    this.closed = true;
    this.isTurnRunning = false;
    this.rpc.detach();
  }
}
