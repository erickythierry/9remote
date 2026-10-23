// Claude chat over the TUI in the chat's own terminal: one CLI process, two views.
// The chat types into the PTY and rebuilds its log from the TUI's transcript, so
// switching between chat and terminal never stops the CLI or forks the conversation.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as daemonClient from "../terminal/ptyDaemonClient.js";
import { agentById, agentIdFromProcess, isShellProcess } from "../terminal/agentCatalog.js";
import { getConversation, setConversationId, getLastOutputAt, getStatus, getSessionAgent } from "../terminal/statusManager.js";
import { isTuiChatSurface, engineFromAgent } from "../terminal/conversationModes.js";
import { CLEAR_LINE } from "../terminal/sessionMode.js";
import { UPLOAD_DIR } from "../terminal/constants.js";
import { findTranscript, CLAUDE_SESSION_ID_RE, claudeRecordParser, replayClaudeLines, liveTranscript } from "./claudeTranscript.js";
import { stageAttachment, buildAttachedPrompt, type AttachmentInput } from "./aiAttachment.js";
import { AI_ENGINES, CLAUDE_QUEUE_CONFIRM_MS, CLAUDE_TERMINAL_POLL_MS, CLAUDE_TERMINAL_BOOT_MS, CLAUDE_TERMINAL_SETTLE_MS, CLAUDE_TERMINAL_ENTER_MS, CLAUDE_SHELL_TAIL_BYTES, CLAUDE_SHELL_TAIL_LINES } from "./constants.js";
import { createLogger } from "../../lib/logger.js";
import type { AiSession, PromptQueueItem } from "./aiSession.js";

const logger = createLogger("claudeTerminal");
const WAIT_STEP_MS = 100;
// Bracketed paste keeps a multi-line prompt one message instead of one per line.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Esc is how the TUI interrupts a running turn.
const INTERRUPT = "\x1b";
// The mode reaches a shell line, so only a bare word may pass.
const MODE_RE = /^[A-Za-z]+$/;
// Model and effort are typed as slash-command arguments and as launch flags: a bare id only.
const OPTION_RE = /^[\w.:@/[\]-]+$/;
const READ_CHUNK = 1 << 20;
// A sub-agent's steps nest under its Task row; its prose and prompts stay out of the main log.
const CHILD_EVENTS = new Set(["tool_start", "tool_result"]);

// The ack names the file the harness writes the shell's output to; only `<id>.output` in a tasks dir is followed.
const OUTPUT_FILE_RE = /Output is being written to:\s*(\S+?\/tasks\/[A-Za-z0-9_-]+\.output)\b/;

type Shell = { id: string; file: string; ack: string; size: number; parentToolUseId?: string };

// The last lines of a file, read from its end so a huge log costs one bounded read.
function readTailText(file: string, size: number): string {
  const len = Math.min(size, CLAUDE_SHELL_TAIL_BYTES);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8", 0, n).split("\n");
    // A cut first line (mid-file start) is dropped rather than shown half.
    if (size > len) lines.shift();
    return lines.slice(-CLAUDE_SHELL_TAIL_LINES).join("\n");
  } catch { return ""; } finally { if (fd != null) fs.closeSync(fd); }
}

type Tail = { file: string; offset: number; partial: string; parse: (d: any, turnEnds?: boolean) => void };

// Appended bytes since the last read, as whole lines; the tail keeps the unterminated rest.
function readLines(tail: Tail): string[] | null {
  let size: number;
  try { size = fs.statSync(tail.file).size; } catch { return null; }
  if (size <= tail.offset) return [];
  let fd: number | null = null;
  let text = "";
  // A chunk boundary can split a multi-byte character; the decoder holds it for the next read.
  const decoder = new StringDecoder("utf8");
  try {
    fd = fs.openSync(tail.file, "r");
    while (tail.offset < size) {
      const buf = Buffer.alloc(Math.min(READ_CHUNK, size - tail.offset));
      const n = fs.readSync(fd, buf, 0, buf.length, tail.offset);
      if (!n) break;
      tail.offset += n;
      text += decoder.write(buf.subarray(0, n));
    }
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
  const lines = (tail.partial + text).split("\n");
  tail.partial = lines.pop() || "";
  return lines;
}

// Permission gates are keyed apart from questions: their answer is a decision, not answers.
export const PERMISSION_GATE_PREFIX = "perm-";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The TUI rewrites a pasted prompt: image paths become "[Image #N]" and long text is wrapped in <pasted_content>.
const ECHO_NOISE_RE = new RegExp(`\\[Image #\\d+\\]|</?pasted_content[^>]*>|${UPLOAD_DIR}/\\S+`, "g");
export const echoKey = (text: string) => text.replace(ECHO_NOISE_RE, " ").replace(/\s+/g, " ").trim();

export class ClaudeTerminal {
  session: AiSession;
  timer: NodeJS.Timeout | null = null;
  file: string | null = null;
  // Byte offset already parsed, and the unterminated tail line left over from the last read.
  offset = 0;
  partial = "";
  // Fed every new record; it remembers tool calls, so it lives as long as the file it reads.
  parse: ((d: any, turnEnds?: boolean) => void) | null = null;
  muted = false;
  // Prompts the chat typed, already drawn by the session; their transcript echo is skipped once.
  echoes: string[] = [];
  // What the TUI holds in its prompt queue, folded from the transcript's queue-operation records.
  // Hidden entries (task notifications) take part in the FIFO but are never shown.
  queued: { id: string; text: string; key: string; hidden: boolean }[] = [];
  queueSeq = 0;
  // Sub-agent transcripts by file, each nested under the Task call that spawned it.
  agents = new Map<string, Tail>();
  // Background shells still running, by tool id: their output file is tailed into the row.
  shells = new Map<string, Shell>();
  // Open AskUserQuestion gates by request id; each resolves its hook's held request.
  questions = new Map<string, (answer: any) => void>();
  // Last conversation id the hooks reported; only a NEW one moves the chat (a /clear must not snap back).
  followed: string | null = null;
  booting: Promise<void> | null = null;

  constructor(session: AiSession) {
    this.session = session;
  }

  async start() {
    const s = this.session;
    // The KV may hold the conversation id when the snapshot file is gone.
    await s._kvPromise?.catch(() => {});
    // A headless CLI left by the pre-terminal chat would hold the same conversation.
    if (daemonClient.isConnected()) await daemonClient.procStop(s.id).catch(() => {});
    const live = this.hookConversation();
    this.followed = live;
    if (live) s.cliSessionId = live;
    this.timer = setInterval(() => this.tick(), CLAUDE_TERMINAL_POLL_MS);
    // A chat-first tab shows the TUI in its terminal from the start; a terminal-first one already runs it.
    if (isTuiChatSurface(getSessionAgent(s.id))) {
      this.ensureTui().catch((err) => logger.warn(`session ${s.id}: ${err.message}`));
    }
  }

  hookConversation(): string | null {
    const conv = getConversation(this.session.id);
    if (!conv?.id || engineFromAgent(conv.agent) !== AI_ENGINES.CLAUDE) return null;
    return CLAUDE_SESSION_ID_RE.test(conv.id) ? conv.id : null;
  }

  async foreground(): Promise<string | null> {
    const live = await daemonClient.listSessions().catch(() => []);
    return live.find((t) => t.id === this.session.id)?.foregroundProcess || null;
  }

  async tuiRunning() {
    return agentIdFromProcess(await this.foreground()) === AI_ENGINES.CLAUDE;
  }

  // Waits for the PTY to go quiet with `ready` true; false once the boot budget is spent.
  async settle(ready: () => Promise<boolean>) {
    const deadline = Date.now() + CLAUDE_TERMINAL_BOOT_MS;
    while (Date.now() < deadline && !this.session.destroyed) {
      const quiet = Date.now() - getLastOutputAt(this.session.id) >= CLAUDE_TERMINAL_SETTLE_MS;
      if (quiet && await ready()) return true;
      await sleep(WAIT_STEP_MS);
    }
    return false;
  }

  ensureTui() {
    if (!this.booting) this.booting = this.boot().finally(() => { this.booting = null; });
    return this.booting;
  }

  async boot() {
    if (await this.tuiRunning()) return;
    const s = this.session;
    await this.settle(async () => isShellProcess(await this.foreground()));
    if (await this.tuiRunning()) return;
    // Typing the launch line into another program (an editor, a pager) would garble it.
    if (!isShellProcess(await this.foreground())) throw new Error("The terminal is busy with another program");
    if (!s.cliSessionId || !CLAUDE_SESSION_ID_RE.test(s.cliSessionId)) s.cliSessionId = randomUUID();
    // No transcript yet means the CLI never wrote this id: it must be created, not resumed.
    const fresh = !findTranscript(s.cwd, s.cliSessionId);
    setConversationId(s.id, AI_ENGINES.CLAUDE, s.cliSessionId, "resume");
    this.followed = s.cliSessionId;
    daemonClient.sendInput(s.id, `${CLEAR_LINE}${this.launchLine(fresh)}\r`);
    logger.info(`session ${s.id}: TUI ${fresh ? "start" : "resume"} ${s.cliSessionId}`);
    if (!await this.settle(() => this.tuiRunning())) throw new Error("Claude Code did not start in this terminal");
    // The process is up before its input box is drawn; keys typed earlier are lost.
    await this.settle(async () => true);
  }

  launchLine(fresh: boolean) {
    const s = this.session;
    const agent = agentById(AI_ENGINES.CLAUDE);
    const cmd = s.options.launcher || agent?.cmd || AI_ENGINES.CLAUDE;
    const mode = s.permissionMode || s.options.defaultMode || "";
    const perm = mode === "bypassPermissions"
      ? agent?.yolo
      : (MODE_RE.test(mode) && mode !== "default" ? `--permission-mode ${mode}` : "");
    // Quoted: ids like `x[1m]` are globs to the shell.
    const model = OPTION_RE.test(s.model) ? `--model '${s.model}'` : "";
    const effort = OPTION_RE.test(s.effort) ? `--effort '${s.effort}'` : "";
    return [cmd, fresh ? `--session-id ${s.cliSessionId}` : `--resume ${s.cliSessionId}`, perm, model, effort].filter(Boolean).join(" ");
  }

  async send(prompt: string, attachments: AttachmentInput[] | null, queued: PromptQueueItem | null = null) {
    // A running TUI takes typed input mid-turn and queues it itself.
    await this.ensureTui();
    const staged = (attachments || []).map(stageAttachment);
    const text = buildAttachedPrompt(prompt, staged, true);
    // A queued prompt is drawn when the TUI takes it, so its transcript echo is not one to skip.
    if (queued) queued.key = echoKey(text);
    else this.echoes.push(echoKey(text));
    await this.type(text);
  }

  // The TUI's queue is FIFO: enqueue appends, dequeue takes the head, remove names one, popAll empties it.
  queueRecord(d: any) {
    if (d.type !== "queue-operation") return;
    const text = typeof d.content === "string" ? d.content : "";
    const key = echoKey(text);
    switch (d.operation) {
      case "enqueue":
        this.queued.push({ id: `tq-${++this.queueSeq}`, text, key, hidden: !key || text.includes("<task-notification>") });
        return;
      case "dequeue":
        this.queued.shift();
        return;
      case "popAll":
        this.queued = [];
        return;
      case "remove": {
        const at = this.queued.findIndex((q) => q.key === key);
        if (at === -1) return;
        this.queued.splice(at, 1);
      }
    }
  }

  // The chat's queue is the TUI's, plus what the chat typed that the transcript has not shown yet.
  syncQueue() {
    const s = this.session;
    const mine = s.promptQueue.filter((i) => i.tui);
    const used = new Set<string>();
    const shown = this.queued.filter((q) => !q.hidden).map((q): PromptQueueItem => {
      const hit = mine.find((i) => !used.has(i.id) && i.key === q.key);
      if (!hit) return { id: q.id, text: q.text, key: q.key, tui: true, seen: true };
      used.add(hit.id);
      hit.seen = true;
      return hit;
    });
    const waiting = mine.filter((i) => !i.seen && Date.now() - (i.at || 0) < CLAUDE_QUEUE_CONFIRM_MS);
    const next = [...shown, ...waiting];
    const sig = (list: PromptQueueItem[]) => list.map((i) => i.id).join("|");
    if (sig(next) === sig(s.promptQueue)) return;
    s.promptQueue = next;
    s.emitQueueUpdate();
  }

  async type(text: string) {
    const id = this.session.id;
    daemonClient.sendInput(id, text.includes("\n") ? `${PASTE_START}${text}${PASTE_END}` : text);
    await sleep(CLAUDE_TERMINAL_ENTER_MS);
    daemonClient.sendInput(id, "\r");
  }

  // Model/effort through the TUI's own commands: the running CLI switches with no restart.
  // Only between turns — the session defers a pick made mid-turn (see setOptions).
  async applyOptions({ model, effort }: { model?: string; effort?: string }) {
    if (!await this.tuiRunning()) return;
    if (model && OPTION_RE.test(model)) await this.type(`/model ${model}`);
    if (effort && OPTION_RE.test(effort)) {
      await this.settle(async () => true);
      await this.type(`/effort ${effort}`);
    }
  }

  interrupt() {
    return daemonClient.sendInput(this.session.id, INTERRUPT);
  }

  tick() {
    const s = this.session;
    if (s.destroyed) return this.dispose();
    const live = this.hookConversation();
    if (live && live !== this.followed) {
      // /clear or /resume in the TUI moved it to another conversation; the chat follows.
      this.followed = live;
      s.cliSessionId = live;
      s.attachmentOffset = null;
      this.file = null;
    }
    // A prompt typed in the terminal starts a turn the chat did not send.
    if (!s.isTurnRunning && getStatus(s.id)?.state === "working") {
      s.isTurnRunning = true;
      s.turnStartedAt = Date.now();
    }
    if (!s.cliSessionId) return;
    if (!this.file) {
      this.file = findTranscript(s.cwd, s.cliSessionId);
      if (this.file) this.reload();
      return;
    }
    let size: number;
    try { size = fs.statSync(this.file).size; } catch { this.file = null; return; }
    // Shrunk: the file was rewritten, so the offset no longer indexes it.
    if (size < this.offset) return this.reload();
    if (size > this.offset) this.readTail();
    this.readAgents();
    this.readShells();
  }

  // A launch ack opens a tailed shell; its task notification closes it.
  trackShell(ev: { event: string; data: any }, parentToolUseId?: string) {
    const d = ev.data;
    if (ev.event === "tool_result" && d?.async && d?.handle && d?.id) {
      const file = OUTPUT_FILE_RE.exec(String(d.output || ""))?.[1];
      if (file) this.shells.set(d.id, { id: d.id, file, ack: String(d.output), size: -1, ...(parentToolUseId ? { parentToolUseId } : {}) });
    }
    if (ev.event === "cli_event" && d?.subtype === "task_notification" && d.record?.tool_use_id) this.shells.delete(d.record.tool_use_id);
  }

  // Unrecorded: the tail is a live view, and the log keeps the ack the transcript holds.
  readShells() {
    for (const shell of this.shells.values()) {
      let size: number;
      try { size = fs.statSync(shell.file).size; } catch { continue; }
      if (size === shell.size) continue;
      shell.size = size;
      const tail = readTailText(shell.file, size);
      this.session.emitNormalized("tool_result", {
        id: shell.id, status: "running", async: true, handle: true,
        output: tail ? `${shell.ack}\n\n${tail}` : shell.ack,
        ...(shell.parentToolUseId ? { parentToolUseId: shell.parentToolUseId } : {})
      }, false);
    }
  }

  // <transcript>/subagents/agent-<id>.jsonl, paired with its .meta.json for the Task call id.
  readAgents() {
    const dir = path.join(this.file!.replace(/\.jsonl$/, ""), "subagents");
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      let tail = this.agents.get(file);
      if (!tail) {
        let parent = "";
        try { parent = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")).toolUseId || ""; } catch {}
        // No meta yet: retried next tick, so no step lands unparented.
        if (!parent) continue;
        const emit = (ev: { event: string; data: any }) => {
          this.trackShell(ev, parent);
          if (CHILD_EVENTS.has(ev.event)) this.session.emitNormalized(ev.event, { ...ev.data, parentToolUseId: parent });
        };
        tail = { file, offset: 0, partial: "", parse: claudeRecordParser(emit) };
        this.agents.set(file, tail);
      }
      const lines = readLines(tail);
      // Every record here is a sidechain; the main parser's sidechain guard would drop its tool results.
      if (lines?.length) replayClaudeLines(lines, null, (d) => tail!.parse({ ...d, isSidechain: false }, false));
    }
  }

  // One full rebuild per file; after it only appended bytes are parsed.
  reload() {
    const s = this.session;
    s.refreshFromStore();
    // The rebuilt log has no sub-agent steps; re-reading each file from 0 puts them back.
    this.agents.clear();
    this.partial = "";
    // The muted replay only teaches the parser the tool calls a later result answers.
    const { lines, live } = liveTranscript(this.file!);
    this.shells.clear();
    this.parse = claudeRecordParser((ev) => {
      this.trackShell(ev);
      // Attachments come in through the session's own turn-end read; a second door would draw them twice.
      if (this.muted || (ev.event === "cli_event" && ev.data?.type === "attachment")) return;
      if (ev.event === "user_message") {
        // Up to the match: a slash command never echoes as a user record, so its entry is dropped here.
        const at = this.echoes.indexOf(echoKey(String(ev.data?.text || "")));
        if (at !== -1) { this.echoes.splice(0, at + 1); return; }
      }
      s.emitNormalized(ev.event, ev.data);
    });
    this.muted = true;
    this.queued = [];
    replayClaudeLines(lines, live, (d) => { this.queueRecord(d); this.parse!(d, false); });
    this.muted = false;
    // A queue left over from a TUI that died mid-turn would never drain.
    if (!s.isTurnRunning && getStatus(s.id)?.state !== "working") this.queued = [];
    this.syncQueue();
    try { this.offset = fs.statSync(this.file!).size; } catch { this.offset = 0; }
  }

  // shortcut: appended records are taken as the live branch; a /rewind typed in the TUI shows on the next reload.
  readTail() {
    const tail: Tail = { file: this.file!, offset: this.offset, partial: this.partial, parse: this.parse! };
    const lines = readLines(tail);
    if (!lines) return;
    this.offset = tail.offset;
    this.partial = tail.partial;
    // The Stop hook ends the turn (aiManager's done releaser): one assistant record is only one step of it.
    replayClaudeLines(lines, null, (d) => { this.queueRecord(d); this.parse!(d, false); });
    this.syncQueue();
  }

  // The card is the existing permission_request one; its answer goes back through resolveQuestion.
  // One gate per held hook: a question (answers) or a permission ({ behavior, message }). null hands it back to the TUI.
  ask(requestId: string, tool: string, input: any, waitMs: number): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(requestId, null), waitMs);
      this.questions.set(requestId, (answer) => { clearTimeout(timer); resolve(answer); });
      this.session.emitNormalized("permission_request", { requestId, tool, input, type: tool === "AskUserQuestion" ? "question" : "permission" });
    });
  }

  // false when the gate is gone (answered elsewhere, timed out) so the card reports it.
  answer(requestId: string, answer: any) {
    const done = this.questions.get(requestId);
    if (!done) return false;
    this.questions.delete(requestId);
    done(answer);
    this.session.emitNormalized("permission_resolved", { requestId, behavior: answer?.behavior || (answer ? "allow" : "deny") });
    return true;
  }

  dispose() {
    // A held hook must not hang its TUI once the chat is gone.
    for (const id of [...this.questions.keys()]) this.answer(id, null);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
