// Rebuilds a chat log from Claude's own transcript file; split from ptyDaemon so the lookup is testable without a daemon.
import fs from "fs";
import path from "path";
import os from "os";
import { isInjectedTurn } from "../terminal/agentHistory.js";
import { buildEditDiff, DIFF_TOOL_NAMES, collapsePersisted } from "./adapters/claudeAdapter.js";
import { toolStart, toolResult, asyncHandle, taskNotificationFrom } from "./toolEvent.js";
import { addSessionUsage, type SessionUsageStats } from "./usage.js";
import { claudeProjectsDirs } from "./claudeProfile.js";

// Untrusted client-supplied id: plain ids only, plus a projects-dir jail below — `..` would otherwise read any file on disk.
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

// Origins the CLI writes its own messages under — not turns anyone typed.
const CLAUDE_INJECTED_ORIGINS = ["task-notification"];

// Replay emits subtype: "task_notification" via taskNotificationFrom (shared with claudeAdapter).
export { taskNotificationFrom };

// The flags decide, not the text — most injected records carry no text marker, and passing one to --rewind-files fails the whole rewind.
export function isClaudeInjectedTurn(record: any): boolean {
  if (record.isMeta || record.turnCompanion) return true;
  // The compaction's own summary — harness talking to itself, nothing a pane shows.
  if (record.isCompactSummary) return true;
  return CLAUDE_INJECTED_ORIGINS.includes(record.origin?.kind);
}

const readdirOr = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };

// The pane draws a row from only two kinds (a SessionStart hook's output, a queued
// prompt); every other attachment body (environment snapshot, listings, instructions)
// renders nothing. Carried whole, one conversation's attachments evict its real turns
// from the replay window a reopened pane hydrates from.
function slimAttachmentRecord(record: any): { attachment: Record<string, any> } {
  const a = record?.attachment || {};
  const attachment: Record<string, any> = {};
  for (const key of ["type", "hookEvent", "hookName", "filename", "content", "prompt"]) {
    if (a[key] !== undefined) attachment[key] = a[key];
  }
  return { attachment };
}

const LAUNCH_TASK_TOOLS = new Set(["Agent", "Task", "Bash", "Monitor", "Workflow"]);
const STOP_TASK_TOOLS = new Set(["TaskStop", "KillShell"]);

// hookInfos[].command is each hook's whole command line and can hold a token; the pane needs only counts and times.
function slimSystemRecord(record: any): any {
  if (record?.subtype !== "stop_hook_summary") return record;
  const { hookInfos, hookErrors, hookAdditionalContext, ...rest } = record;
  return {
    ...rest,
    hookDurationsMs: (hookInfos || []).map((h: any) => Number(h?.durationMs) || 0),
    hookErrorCount: (hookErrors || []).length
  };
}

const ENTRYPOINT_RE = /"entrypoint":"([^"]+)"/;
const ENTRYPOINT_HEAD_BYTES = 64 * 1024;
const entrypoints = new Map<string, string>();

// "cli" is the interactive TUI; a background sub-agent runs as its own headless session ("sdk-cli") with its own id.
export function claudeEntrypoint(cliSessionId: string, file: string): string | null {
  const known = entrypoints.get(cliSessionId);
  if (known) return known;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(ENTRYPOINT_HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const found = ENTRYPOINT_RE.exec(buf.toString("utf8", 0, read))?.[1];
    if (found) entrypoints.set(cliSessionId, found);
    return found ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function findTranscript(cwd: string, cliSessionId: string, launcher: string = ""): string | null {
  const safeCwd = String(cwd).replace(/[/\\:]/g, "-");
  for (const projectsDir of claudeProjectsDirs(launcher)) {
    let p = path.join(projectsDir, safeCwd, `${cliSessionId}.jsonl`);
    if (!fs.existsSync(p) && !safeCwd.startsWith("-")) {
      p = path.join(projectsDir, `-${safeCwd}`, `${cliSessionId}.jsonl`);
    }
    // The transcript lives under the dir the CLI was started in, not the terminal's current cwd — find by id on miss.
    if (!fs.existsSync(p)) {
      for (const entry of readdirOr(projectsDir)) {
        const candidate = path.join(projectsDir, entry, `${cliSessionId}.jsonl`);
        if (fs.existsSync(candidate)) { p = candidate; break; }
      }
    }
    // Defense in depth: even with the id validated, never read outside the projects dir.
    const resolved = path.resolve(p);
    if (!resolved.startsWith(path.resolve(projectsDir) + path.sep)) continue;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

// The CALL carries the edit strings, the result only the id — keyed like the live adapter's toolCalls.
const DIFF_TOOL_SET = new Set(DIFF_TOOL_NAMES);

// The SAME test decides user_message, tool results and rewind indices — disagreeing copies misplace the rewind cut.
export const textOf = (record: any): string => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.find((c: any) => c.type === "text")?.text || "";
  return "";
};

export const isTypedTurn = (record: any): boolean => {
  const text = textOf(record);
  // isInjectedTurn is the reader's last word here too — without it the rewind list counted turns the pane never drew.
  return record.type === "user" && !record.isSidechain && !isClaudeInjectedTurn(record)
    && Boolean(text) && !isInjectedTurn(text);
};

// One read of the transcript for every reader that needs it: a record parsed once,
// kept beside its line. The live-turn rule, the event walk and the session state all
// read the same file, and parsing it once per reader cost more than the walk itself.
export function readTranscript(file: string): { lines: string[]; records: any[] } {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { lines: [], records: [] }; }
  // Walk the string instead of split()ing it: a tens-of-megabytes transcript pays for
  // every line string it allocates, and only the records are ever read. Empty lines
  // keep their slot so `records[i]` still lines up with `lines[i]`.
  const lines: string[] = [];
  const records: any[] = [];
  let start = 0;
  for (;;) {
    const nl = raw.indexOf("\n", start);
    const end = nl === -1 ? raw.length : nl;
    const line = end > start ? raw.slice(start, end) : "";
    lines.push(line);
    if (!line.trim()) records.push(null);
    else { try { records.push(JSON.parse(line)); } catch { records.push(null); } }
    if (nl === -1) break;
    start = nl + 1;
  }
  return { lines, records };
}

// A rewind only moves the leafUuid pointer and leaves dropped turns in the file, and the live branch can be non-contiguous — so keep the parentUuid chain, never a line range.
export function liveTurns(records: any[], leafOverride: string | null = null): Set<string> | null {
  let leaf = leafOverride;
  // leafOverride: the CLI answers a rewind ~50ms before it flushes the new last-prompt — read as-if-written in that window.
  let lastPointer = -1;
  const byUuid = new Map<string, any>();
  const at = new Map<string, number>();
  const turns: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const d = records[index];
    if (!d) continue;
    if (d.type === "last-prompt" && d.leafUuid) { if (!leafOverride) leaf = d.leafUuid; lastPointer = index; }
    if (!d.uuid) continue;
    byUuid.set(d.uuid, d);
    at.set(d.uuid, index);
    if (isTypedTurn(d)) turns.push(d.uuid);
  }
  if (!leaf || !turns.length) return null;

  const onBranch = new Set<string>();
  for (let cur = leaf; cur && byUuid.has(cur) && !onBranch.has(cur); ) {
    onBranch.add(cur);
    cur = byUuid.get(cur).parentUuid;
  }
  if (!onBranch.size) return null;

  // Outside the pointer's reach, believe the file: turns above a compaction and below the newest last-prompt stay live — but an override speaks for everything below it.
  let firstReached = Infinity;
  for (const uuid of onBranch) firstReached = Math.min(firstReached, at.get(uuid) ?? Infinity);

  const live = new Set<string>();
  for (const uuid of turns) {
    const line = at.get(uuid) ?? -1;
    if (onBranch.has(uuid) || (leafOverride ? false : (line < firstReached || line > lastPointer))) live.add(uuid);
  }
  return live;
}

// The ONE place the leaf rule is applied, so the pane and the rewind list cannot disagree on which turns exist.
export function liveTranscript(file: string, leafOverride: string | null = null): { lines: string[]; records: any[]; live: Set<string> | null } {
  const { lines, records } = readTranscript(file);
  return { lines, records, live: liveTurns(records, leafOverride) };
}

type ClaudeEvent = { event: string; data: any };

// One transcript record into pane events; the returned fn keeps tool calls across records so a result finds its call.
// turnEnds=false for a live tail, where the Stop hook (not each assistant record) ends the turn.
export function claudeRecordParser(push: (ev: ClaudeEvent) => void) {
  // Tool calls awaiting their result, by tool_use id — see DIFF_TOOL_SET.
  const toolCalls = new Map<string, { name: string; input: any }>();
  // Launcher tool_use id by task handle: TaskStop names only the handle, and the row to close is the launcher's.
  const launcherOf = new Map<string, string>();
  // The TUI writes no result record, so the chat's token totals are summed here, per API call.
  const sessionUsage: SessionUsageStats = {};
  const usageSeen = new Set<string>();
  // A notification ends the tool row it names — on this door the settle is the row's only end (no watchdog in a replay).
  const pushTaskNotification = (task: any) => {
    push(task);
    const toolUseId = task.data.record.tool_use_id;
    // Same shape armAsyncWatchdog settles with, so both doors close the row the same way.
    if (toolUseId) push({ event: "tool_result", data: { id: toolUseId, status: "done", async: true } });
  };
  return (d: any, turnEnds = true) => {
    // Read before the injection guard drops it: the only end signal for a task, or a replay shows it running forever.
    if (d.type === "user" && d.message) {
      const task = taskNotificationFrom(d);
      if (task) pushTaskNotification(task);
    }
    // Demarcate conversation compaction in the chat timeline.
    if (d.isCompactSummary) {
      push({
        event: "cli_event",
        data: {
          type: "system",
          subtype: "context_compacted",
          record: { text: textOf(d) }
        }
      });
    }
    // Sidechain/injected records are not typed turns — drawing them miscounts the rewind indices and ends the log mid-turn.
    if (d.type === "user" && d.message && !d.isSidechain && !isClaudeInjectedTurn(d)) {
      // Through textOf: a typed turn may be a plain string, and .find on a string throws.
      const text = textOf(d);
      if (text && !isInjectedTurn(text)) {
        push({ event: "user_message", data: { text } });
      }
      // A tool result is a `user` record too, and only ever the array form.
      const content = Array.isArray(d.message.content) ? d.message.content : [];
      const toolResults = content.filter((c: any) => c.type === "tool_result");
      for (const tr of toolResults) {
        const output = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
        // Person-visible text: a <persisted-output> frame starts at char 0 of the TEXT, never the serialized form.
        const resultText = typeof tr.content === "string"
          ? tr.content
          : (tr.content || []).map((c: any) => (typeof c === "string" ? c : c?.text || "")).join("");
        // Detect tool output replaced by local hooks (e.g. caveman / shell filter replacements).
        const isFiltered = /trocada por um filtro|output replacement|updatedToolOutput/i.test(resultText);
        // The flag is the whole answer on both doors — a text match only ever added false errors.
        const isError = Boolean(tr.is_error);
        const call = toolCalls.get(tr.tool_use_id);
        toolCalls.delete(tr.tool_use_id);
        // A launch ack is not a result — same rule as the live door, or a reload shows running work as finished.
        const async = isError ? null : asyncHandle(output, call?.name || "");
        push(toolResult({
            id: tr.tool_use_id,
            // The result carries only the id — the name comes from the call it answers.
            name: call?.name || "",
            // Same collapse the live door applies, so a reopened chat shows the line the pane showed live.
            output: isError ? output : collapsePersisted(resultText),
            error: isError ? output : "",
            ...(isFiltered ? { filtered: true } : null),
            // `running`, not `done` — the work outlives the call, and the handle lets a later record settle it.
            ...(async ? { status: "running", async: true, handle: async.id } : null)
          }));
        // A stopped task leaves no <task-notification> in the TUI transcript, only this result; without it a restart replays the task as running forever.
        if (call && !isError && STOP_TASK_TOOLS.has(call.name)) {
          const taskId = String(call.input?.task_id || call.input?.shell_id || "");
          if (taskId) pushTaskNotification({
            event: "cli_event",
            data: {
              type: "system", subtype: "task_notification",
              record: { type: "system", subtype: "task_notification", task_id: taskId, status: "killed", ...(launcherOf.has(taskId) ? { tool_use_id: launcherOf.get(taskId) } : null) }
            }
          });
        }
        // The TUI never writes task_started (only the stream-json CLI does); without it the strip and modal have no name or tool_use_id for the task.
        if (async) launcherOf.set(async.id, tr.tool_use_id);
        if (async && call && LAUNCH_TASK_TOOLS.has(call.name)) {
          const workflow = call.name === "Workflow";
          const agent = call.name === "Agent" || call.name === "Task" || workflow;
          const input = call.input || {};
          // The workflow ack names the run in its `Summary:` line; its input carries only a script.
          const workflowSummary = workflow ? /^Summary:\s*(.+)$/m.exec(resultText)?.[1] : "";
          const description = input.description || workflowSummary || (agent ? "" : input.command) || "";
          const record = {
            type: "system", subtype: "task_started", task_id: async.id, tool_use_id: tr.tool_use_id,
            ...(description ? { description: String(description).slice(0, 200) } : null),
            ...(agent && input.subagent_type ? { subagent_type: input.subagent_type } : null),
            ...(agent ? { async_launch: true } : { is_backgrounded: true, task_type: "local_bash" })
          };
          push({ event: "cli_event", data: { type: "system", subtype: "task_started", record } });
        }
        // A rejected edit never reached the disk, so it paints no diff — the tool row stays to say it was refused.
        if (call && !isError && DIFF_TOOL_SET.has(call.name)) {
          const diff = buildEditDiff(call.name, call.input);
          if (diff) push({ event: "diff", data: diff });
        }
      }
    } else if (d.type === "user" && d.isSidechain && d.parent_tool_use_id && d.message) {
      // A sub-agent's tool results nest under their spawner — same wire events the live door's remap produces (aiSession CHILD_EVENTS).
      const content = Array.isArray(d.message.content) ? d.message.content : [];
      for (const tr of content.filter((c: any) => c.type === "tool_result")) {
        const isError = Boolean(tr.is_error);
        const resultText = typeof tr.content === "string"
          ? tr.content
          : (tr.content || []).map((c: any) => (typeof c === "string" ? c : c?.text || "")).join("");
        const call = toolCalls.get(tr.tool_use_id);
        toolCalls.delete(tr.tool_use_id);
        push({
          event: "tool_result_child",
          data: {
            id: tr.tool_use_id,
            name: call?.name || "",
            output: isError ? resultText : collapsePersisted(resultText),
            error: isError ? resultText : "",
            status: isError ? "error" : "done",
            parentToolUseId: d.parent_tool_use_id
          }
        });
      }
    } else if (d.type === "attachment") {
      // Harness-injected context, slimmed to what the pane can ever draw (see slimAttachmentRecord).
      push({
        event: "cli_event",
        data: { type: "attachment", subtype: d.attachment?.type || "", record: slimAttachmentRecord(d) }
      });
    } else if (d.type === "queue-operation") {
      // A notification queued mid-turn is removed at the turn's end, never re-delivered as a user record — this is its only door.
      const task = taskNotificationFrom(d);
      if (task) pushTaskNotification(task);
      // A prompt typed mid-turn is folded into it: no `user` record is ever written, so the removal is its only trace.
      else if (d.operation === "remove" && d.reason === "absorbed_mid_turn" && typeof d.content === "string" && d.content.trim() && !isInjectedTurn(d.content)) {
        push({ event: "user_message", data: { text: d.content } });
      }
    } else if (d.type === "system") {
      // Carried whole under its own name — the pane (noticeFrom) decides what to show.
      push({
        event: "cli_event",
        data: { type: "system", subtype: d.subtype || "", record: slimSystemRecord(d) }
      });
      if (d.subtype === "stop_hook_summary" || d.subtype === "turn_duration") {
        push({ event: "turn_complete", data: { stats: {} } });
      }
    } else if (d.type === "assistant" && d.message) {
      const u = d.message.usage;
      // One record per content block repeats the same message id and usage; count each API call once.
      if (u && d.message.id && !d.isSidechain && !usageSeen.has(d.message.id)) {
        usageSeen.add(d.message.id);
        const cacheRead = u.cache_read_input_tokens || 0;
        const input = (u.input_tokens || 0) + cacheRead + (u.cache_creation_input_tokens || 0);
        if (input) {
          addSessionUsage(sessionUsage, { input, cached: cacheRead, output: u.output_tokens || 0 });
          sessionUsage.sessionCacheWriteTokens = (sessionUsage.sessionCacheWriteTokens || 0) + (u.cache_creation_input_tokens || 0);
          sessionUsage.sessionThinkingTokens = (sessionUsage.sessionThinkingTokens || 0) + (u.output_tokens_details?.thinking_tokens || 0);
          sessionUsage.sessionApiCalls = (sessionUsage.sessionApiCalls || 0) + 1;
          push({
            event: "stats",
            data: {
              stats: {
                ...sessionUsage,
                inputTokens: u.input_tokens || 0,
                outputTokens: u.output_tokens || 0,
                cacheReadInputTokens: cacheRead,
                cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
                contextTokens: input
              }
            }
          });
        }
      }
      // A sidechain record is a sub-agent at work: its calls nest (tool_child), and its thinking/text/turn-end belong to the card.
      const parent: string = (d.isSidechain && d.parent_tool_use_id) || "";
      for (const item of d.message.content || []) {
        if (item.type === "thinking" && item.thinking && !parent) {
          push({ event: "thinking", data: { text: item.thinking } });
        } else if (item.type === "tool_use") {
          // Held for its result: the diff is built from this call's input — the result carries only the id.
          toolCalls.set(item.id, { name: item.name, input: item.input });
          const start = toolStart({ id: item.id, name: item.name, input: item.input, parentToolUseId: parent || null });
          push(parent ? { ...start, event: "tool_child" } : start);
        } else if (item.type === "text" && item.text && !parent) {
          push({ event: "delta", data: { text: item.text } });
        }
      }
      if (turnEnds && !parent) push({ event: "turn_complete", data: { stats: {} } });
    }
  };
}

// Reopening a chat re-reads the same transcript, and it is usually unchanged since the
// last look — a reattach after an F5 must still answer, but it need not redo the whole
// rebuild to do it. Keyed on size+mtime, so any append invalidates it; a file that
// shrank (a rewind rewrote it) misses too, since the key cannot match.
//
// Only the ANSWER is kept: the parsed records are what a cold read produces on its way
// to it, and holding both doubled what an open chat costs in RAM for a value nothing
// reads again. A miss re-reads the file, which is exactly when it is needed.
const TRANSCRIPT_CACHE_MAX = 4;
type ClaudeBundle = { events: any[] | null; state: Record<string, any> | null };
const transcriptCache = new Map<string, { key: string; bundle: ClaudeBundle; startSeq: number }>();

/** The file's cache identity, or null when it cannot be read. */
function transcriptKey(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}\u0000${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function cacheLookup(file: string, key: string) {
  const hit = transcriptCache.get(file);
  if (!hit || hit.key !== key) return null;
  // Refresh LRU position.
  transcriptCache.delete(file);
  transcriptCache.set(file, hit);
  return hit;
}

function cacheStore(file: string, key: string, value: { bundle: ClaudeBundle; startSeq: number }) {
  transcriptCache.delete(file);
  transcriptCache.set(file, { key, ...value });
  if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    transcriptCache.delete(transcriptCache.keys().next().value!);
  }
}

/** Test seam: the cache must never make a stale read look fresh. */
export function clearTranscriptCache() { transcriptCache.clear(); }

// leafOverride: read as if that pointer were already flushed — see liveTurns.
export function recoverFromClaudeTranscript(cwd: string, cliSessionId: string, startSeq: number = 1, leafOverride: string | null = null): any[] | null {
  const bundle = recoverClaudeBundle(cwd, cliSessionId, { startSeq, leafOverride });
  return bundle?.events || null;
}

/**
 * Both readers of one transcript in a single read: the rebuilt event log and the
 * session state. They always look at the same file, so reading it twice bought
 * nothing but a second parse of everything the first pass had already decoded.
 */
export function recoverClaudeBundle(cwd: string | undefined, cliSessionId: string | undefined, { startSeq = 1, leafOverride = null }: { startSeq?: number; leafOverride?: string | null } = {}): ClaudeBundle | null {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const resolved = findTranscript(cwd, cliSessionId);
  if (!resolved) return null;

  // A rewind is rewriting this very file as it asks; the caller needs what is on disk
  // right now, not what the last open happened to see. It also reads a different
  // branch than a plain open, so its answer is not the one to cache either.
  if (leafOverride) {
    return buildBundle(resolved, readTranscript(resolved).records, leafOverride, startSeq);
  }

  const key = transcriptKey(resolved);
  // A file that could not be stat'ed cannot be cached; read it and let the read decide.
  if (key == null) return buildBundle(resolved, readTranscript(resolved).records, null, startSeq);

  // The cache stores the ANSWER, not the parse: rebuilding events from unchanged
  // records is where the remaining time went, so reusing only the records saved half.
  const hit = cacheLookup(resolved, key);
  if (hit?.bundle && hit.startSeq === startSeq) return hit.bundle;

  const bundle = buildBundle(resolved, readTranscript(resolved).records, null, startSeq);
  cacheStore(resolved, key, { bundle, startSeq });
  return bundle;
}

function buildBundle(resolved: string, records: any[], leafOverride: string | null, startSeq: number): ClaudeBundle {
  // Same rule the rewind list reads — see liveTranscript.
  const live = liveTurns(records, leafOverride);
  const events = buildClaudeEvents(resolved, records, live, startSeq);
  return { events, state: readClaudeSessionStateFromRecords(records) };
}

function buildClaudeEvents(resolved: string, records: any[], live: Set<string> | null, startSeq: number): any[] | null {
  try {
    let seq = startSeq;
    const events: any[] = [];
    const push = (ev: ClaudeEvent) => events.push({ seq: seq++, ...ev });
    replayClaudeRecords(records, live, claudeRecordParser(push));
    replayClaudeSubagents(resolved, events, push);
    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}

// CLI 2.1+: a sub-agent's records live in <sid>/subagents/agent-*.jsonl, with the spawner's tool_use id in the .meta.json.
// Walked after the main pass so every parent card exists before its children arrive; same remap as claudeTerminal.readAgents.
function replayClaudeSubagents(resolved: string, events: any[], push: (ev: ClaudeEvent) => void) {
  const subByTool = new Map<string, string>();
  const subsDir = path.join(path.dirname(resolved), path.basename(resolved, ".jsonl"), "subagents");
  for (const name of readdirOr(subsDir)) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subsDir, name), "utf8"));
      const file = path.join(subsDir, name.replace(/\.meta\.json$/, ".jsonl"));
      if (meta.toolUseId && fs.existsSync(file)) subByTool.set(meta.toolUseId, file);
    } catch {}
  }
  if (!subByTool.size) return;
  const walked = new Set<string>();
  const walk = (file: string, parent: string) => {
    if (walked.has(file)) return;
    walked.add(file);
    const parse = claudeRecordParser((ev) => {
      if (ev.event !== "tool_start" && ev.event !== "tool_result") return;
      push({ event: ev.event === "tool_start" ? "tool_child" : "tool_result_child", data: { ...ev.data, parentToolUseId: parent } });
      // A sub-agent may spawn one of its own — its file nests the same way.
      if (ev.event === "tool_start" && subByTool.has(ev.data.id)) walk(subByTool.get(ev.data.id)!, ev.data.id);
    });
    // Every record here is a sidechain; the main parser's sidechain guard would drop its tool results.
    for (const d of readTranscript(file).records) {
      if (d) try { parse({ ...d, isSidechain: false }, false); } catch {}
    }
  };
  // A sub-agent of a rewound-away turn has no card to nest under.
  const launched = new Set(events.filter((e) => e.event === "tool_start").map((e) => e.data?.id));
  for (const [toolUseId, file] of subByTool) {
    if (launched.has(toolUseId)) walk(file, toolUseId);
  }
}

// The branch walk over whole lines; the parser is the caller's so a live tail can keep its tool-call memory.
export function replayClaudeLines(lines: string[], live: Set<string> | null, parse: (d: any) => void) {
  let cut = false;   // set when the walk passes a turn the branch no longer holds
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      // A dropped turn takes its answer with it; the cuts interleave, so follow the turns, not one cut point.
      if (live && isTypedTurn(d)) cut = !live.has(d.uuid);
      if (cut) continue;
      parse(d);
    } catch {}
  }
}

// replayClaudeLines over records already parsed by readTranscript.
export function replayClaudeRecords(records: any[], live: Set<string> | null, parse: (d: any) => void) {
  let cut = false;
  for (const d of records) {
    if (!d) continue;
    try {
      if (live && isTypedTurn(d)) cut = !live.has(d.uuid);
      if (cut) continue;
      parse(d);
    } catch {}
  }
}

// The LAST record of each kind wins; absent stays absent so it cannot blank a live value. cost-state is skipped — stale at 0.
// Reads already-parsed records when a caller has them (one file read serves the rebuild too).
export function readClaudeSessionStateFromRecords(records: any[] | null | undefined): Record<string, any> | null {
  const out: Record<string, any> = {};
  for (const d of records || []) {
    if (!d) continue;
    switch (d.type) {
      case "permission-mode": if (d.permissionMode) out.permissionMode = d.permissionMode; break;
      // The harness files the mode on every user record too (the TUI's own field), so a
      // stream-json session that never wrote a `permission-mode` record still states one.
      // Last one wins, same as above — the mode the newest turn ran with.
      case "user": if (d.permissionMode) out.permissionMode = d.permissionMode; break;
      case "mode": if (d.mode) out.mode = d.mode; break;
      case "ai-title": if (d.aiTitle) out.title = d.aiTitle; break;
      case "last-prompt": if (d.lastPrompt) out.lastPrompt = d.lastPrompt; break;
      // Only `environment` carries the session's own cwd/git facts — other attachment types are per-turn noise.
      case "attachment": {
        const snap = d.attachment?.type === "environment" ? d.attachment.snapshot : null;
        if (!snap) break;
        if (snap.workingDirectory) out.cwd = snap.workingDirectory;
        out.isWorktree = Boolean(snap.isWorktree);
        out.isGitRepo = Boolean(snap.isGitRepo);
        break;
      }
      default: break;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function readClaudeSessionState(cwd: string, cliSessionId: string): Record<string, any> | null {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const file = findTranscript(cwd, cliSessionId);
  if (!file) return null;

  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }

  // Cheap gate before parsing: only these record kinds carry state. Kept as a
  // substring test so a line the walk does not need is never parsed.
  const records: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (!line.includes('"permission-mode"') && !line.includes('"ai-title"') &&
        !line.includes('"last-prompt"') && !line.includes('"attachment"') &&
        !line.includes('"permissionMode"') && !line.includes('"mode"')) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return readClaudeSessionStateFromRecords(records);
}

// stream-json never carries attachments, so tail-read by byte offset; stop before a trailing line still being written.
export function readNewAttachments(cwd: string, cliSessionId: string, offset: number = 0): { records: any[]; offset: number } {
  const nothing = { records: [], offset: offset || 0 };
  if (!cwd || !cliSessionId || !CLAUDE_SESSION_ID_RE.test(cliSessionId)) return nothing;
  const file = findTranscript(cwd, cliSessionId);
  if (!file) return nothing;

  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    // Infinity seeds the offset at EOF without replaying an already-drawn conversation.
    if (offset === Infinity) return { records: [], offset: size };
    const from = Number.isFinite(offset) && offset > 0 ? offset : 0;
    // A shrunk file invalidates the offset — a stale one lands mid-record.
    if (from > size) return { records: [], offset: 0 };
    if (from === size) return { records: [], offset: from };

    fd = fs.openSync(file, "r");
    const length = size - from;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, from);
    const text = buf.subarray(0, read).toString("utf8");

    // Only whole lines are records — keep the offset before the partial last line.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return { records: [], offset: from };
    const complete = text.slice(0, lastNewline);

    const records: any[] = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d?.type === "attachment" && d.attachment?.type) records.push(d);
    }
    // Bytes, not characters — a multi-byte char would resume short.
    return { records, offset: from + Buffer.byteLength(complete, "utf8") + 1 };
  } catch {
    return nothing;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
