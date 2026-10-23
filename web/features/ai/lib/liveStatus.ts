// Formats live activity status for the active turn.
import { getToolCategory } from "../registry";

export function describeActivity(tool: any, engine: string = "claude"): string {
  if (!tool?.name) return "";
  const { name, input = {} } = tool;
  const path = baseName(input.file_path || input.path);
  switch (getToolCategory(engine, name)) {
    case "bash":
      return clip(input.description || input.command || "shell", MAX_DETAIL);
    case "file":
      return clip(`${/^(list|list_dir|ls)$/i.test(name) ? "Listing" : "Reading"} ${path}`, MAX_DETAIL);
    case "search":
      return clip([input.pattern ? `"${input.pattern}"` : input.query || input.url || "", path ? `in ${path}` : ""].filter(Boolean).join(" "), MAX_DETAIL);
    case "diff":
      return clip(`${/^(Write|write_to_file)$/i.test(name) ? "Writing" : "Editing"} ${baseName(input.file_path || input.filePath || input.file || input.path) || argOf(input)}`, MAX_DETAIL);
    case "agent":
      return clip(input.description || argOf(input) || "sub-agent", MAX_DETAIL);
    case "plan":
      return clip(baseName(input.path) || name, MAX_DETAIL);
    case "skill": {
      const sName = input.skill || input.skill_name || input.name || "";
      return clip(`Skill: ${sName || "skill"}`, MAX_DETAIL);
    }
    default:
      return clip([toolLabel(name), argOf(input)].filter(Boolean).join(" "), MAX_DETAIL);
  }
}

const MAX_DETAIL = 60;
// Scan only tail of streamed block to find last line efficiently.
const TAIL_SCAN = 512;

const baseName = (p: any): string => (typeof p === "string" ? p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "" : "");

const lastLine = (text: any): string => {
  if (typeof text !== "string") return "";
  const lines = text.slice(-TAIL_SCAN).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
};

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// `mcp__github__create_issue` → `create_issue`. The server is noise on a one-line status.
const toolLabel = (name: string = ""): string => {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return mcp ? mcp[1] : name;
};

const argOf = (input: any = {}): string =>
  input.skill || input.skill_name || input.url || input.query || input.pattern || input.name || baseName(input.path) || baseName(input.file_path) || "";

export interface DescribeLiveOptions {
  connected?: boolean;
  hydrating?: boolean;
  retryStatus?: any;
  activeTool?: any;
  engine?: string;
  lastMsg?: any;
}

export function describeLive({
  connected = true,
  hydrating = false,
  retryStatus = null,
  activeTool = null,
  engine = "",
  lastMsg = null
}: DescribeLiveOptions = {}): { verb: string; detail: string; tone: "alert" | "wait" } {
  // Offline outranks everything: no other line is true while there is no carrier.
  if (!connected) {
    const r = retryStatus || {};
    const detail = r.isRetrying
      ? `attempt ${r.attempt}/${r.maxAttempts}${r.failed ? " · gave up" : ""}`
      : "";
    return { verb: "Reconnecting", detail, tone: "alert" };
  }
  if (hydrating) return { verb: "Syncing", detail: "from host", tone: "wait" };

  if (activeTool?.name) {
    const { name, input = {} } = activeTool;
    const cat = getToolCategory(engine, name);
    const path = baseName(input.file_path || input.path);

    switch (cat) {
      case "bash":
        return { verb: "Running", detail: clip(input.command || "", MAX_DETAIL), tone: "wait" };
      case "file": {
        const listing = /^(list|list_dir|ls)$/i.test(name);
        const line = input.offset ? `:L${input.offset}` : "";
        return { verb: listing ? "Listing" : "Reading", detail: clip(`${path}${line}`, MAX_DETAIL), tone: "wait" };
      }
      case "search": {
        const q = input.pattern ? `"${input.pattern}"` : (input.query || input.url || "");
        const where = baseName(input.path);
        return {
          verb: "Searching",
          detail: clip([q, where ? `in ${where}` : ""].filter(Boolean).join(" "), MAX_DETAIL),
          tone: "wait"
        };
      }
      case "diff": {
        const creating = /^(Write|write_to_file)$/i.test(name);
        // Normalize target file path across engine adapters.
        const file = input.file_path || input.filePath || input.file || input.path;
        return { verb: creating ? "Writing" : "Editing", detail: clip(baseName(file) || argOf(input), MAX_DETAIL), tone: "wait" };
      }
      case "agent": {
        const steps = activeTool.children?.length || 0;
        return {
          verb: "Delegating",
          detail: clip([input.description || argOf(input), steps ? `${steps} steps` : ""].filter(Boolean).join(" · "), MAX_DETAIL),
          tone: "wait"
        };
      }
      case "task":
        return { verb: "Updating tasks", detail: clip(input.activeForm || input.subject || "", MAX_DETAIL), tone: "wait" };
      case "plan":
        return { verb: "Planning", detail: clip(baseName(input.path) || name, MAX_DETAIL), tone: "wait" };
      case "skill": {
        const sName = input.skill || input.skill_name || input.name || "";
        return { verb: "Loading skill", detail: clip(sName, MAX_DETAIL), tone: "wait" };
      }
      default:
        return { verb: "Calling", detail: clip([toolLabel(name), argOf(input)].filter(Boolean).join(" "), MAX_DETAIL), tone: "wait" };
    }
  }

  if (lastMsg?.thinking) return { verb: "Thinking", detail: clip(lastLine(lastMsg.thinking), MAX_DETAIL), tone: "wait" };
  if (lastMsg?.content) return { verb: "Writing", detail: clip(lastLine(lastMsg.content), MAX_DETAIL), tone: "wait" };
  return { verb: "Working", detail: "", tone: "wait" };
}

// Token counts follow the CLI's shorthand: 1234 → 1.2k, 100000 → 100k, 1000000 → 1M
export function formatTokens(n: number | string): string {
  const v = Number(n) || 0;
  const unit = v >= 1e6 ? [1e6, "M"] : v >= 1e3 ? [1e3, "k"] : null;
  if (!unit) return String(v);
  const scaled = v / (unit[0] as number);
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${unit[1]}`;
}

// Rough estimate of 4 characters per token while awaiting reported usage.
const ESTIMATED_CHARS_PER_TOKEN = 4;

// Tokens in session context window normalized across engine adapters.
export function contextUsedTokens(stats: any = {}): number {
  if (Number.isFinite(stats.contextTokens) && stats.contextTokens > 0) return stats.contextTokens;
  return (stats.inputTokens || 0) + (stats.cacheReadInputTokens || 0) + (stats.cacheCreationInputTokens || 0);
}

export function contextFill(stats: any = {}): number | null {
  const used = contextUsedTokens(stats);
  const window = stats.contextWindow || 0;
  return window > 0 ? Math.min(1, used / window) : null;
}

// "45k / 200k · 22%" — tokens alone when no window size is known (claude only learns it after its first turn).
export function contextLabel(stats: any = {}, fallbackWindow: number = 0): { text: string; percent: number | null } | null {
  const used = contextUsedTokens(stats);
  if (!used) return null;
  const window = stats.contextWindow || fallbackWindow || 0;
  if (!window) return { text: formatTokens(used), percent: null };
  const percent = Math.round(Math.min(1, used / window) * 100);
  return { text: `${formatTokens(used)} / ${formatTokens(window)} · ${percent}%`, percent };
}

// "in 4.9M (cache 93%) · out 4.8K": what the whole chat sent and got back, like the CLI's footer.
// Null until an engine reports session totals (the cache share needs a non-zero input).
export function usageLabel(stats: any = {}): string | null {
  const input = stats.sessionInputTokens || 0;
  const output = stats.sessionOutputTokens || 0;
  if (!input && !output) return null;
  const cache = input ? ` (cache ${Math.round(Math.min(1, (stats.sessionCachedTokens || 0) / input) * 100)}%)` : "";
  return `in ${formatTokens(input)}${cache} · out ${formatTokens(output)}`;
}

export interface UsageItem { key: string; icon: string; text: string; label: string }

// The same totals as usageLabel, one item per figure so the bar can draw an icon for each; optional figures appear only once an engine reports them.
export function usageItems(stats: any = {}): UsageItem[] {
  const input = stats.sessionInputTokens || 0;
  const output = stats.sessionOutputTokens || 0;
  if (!input && !output) return [];
  const items: UsageItem[] = [{ key: "in", icon: "ArrowUp", text: formatTokens(input), label: "Sent (cache included)" }];
  if (input) {
    const cached = stats.sessionCachedTokens || 0;
    const write = stats.sessionCacheWriteTokens || 0;
    items.push({
      key: "cache", icon: "Database", text: `${Math.round(Math.min(1, cached / input) * 100)}%`,
      label: `Cache hit · ${formatTokens(cached)} read${write ? ` · ${formatTokens(write)} written` : ""}`
    });
  }
  items.push({ key: "out", icon: "ArrowDown", text: formatTokens(output), label: "Received" });
  if (stats.sessionThinkingTokens > 0) items.push({ key: "think", icon: "Brain", text: formatTokens(stats.sessionThinkingTokens), label: "Thinking (part of received)" });
  if (stats.sessionApiCalls > 0) items.push({ key: "calls", icon: "Zap", text: String(stats.sessionApiCalls), label: "API calls" });
  return items;
}

// Estimate tokens streamed across all messages in current turn.
export function estimateTurnTokens(messages: any[] = []): number {
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    chars += (m.content?.length || 0) + (m.thinking?.length || 0);
  }
  return Math.round(chars / ESTIMATED_CHARS_PER_TOKEN);
}

// Tools that write files; excluded when diff cards exist for the same path.
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write", "patch", "apply",
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "file_change"]);

const lineCount = (text: any): number => (typeof text === "string" && text ? text.split("\n").length : 0);

function countToolEdit(tool: any): { file: string; added: number; removed: number } | null {
  const input = tool.input;
  if (!input || typeof input === "string") return null;
  const path = input.file_path || input.path || input.file || "";
  // MultiEdit (and Antigravity's multi_replace) carry a list of old/new pairs.
  const edits = Array.isArray(input.edits) ? input.edits
    : Array.isArray(input.replacement_chunks) ? input.replacement_chunks
      : Array.isArray(input.replacements) ? input.replacements : null;
  if (edits) {
    let added = 0, removed = 0;
    for (const e of edits) {
      removed += lineCount(e.old_string ?? e.oldString ?? e.old ?? e.target_content);
      added += lineCount(e.new_string ?? e.newString ?? e.new ?? e.replacement_content);
    }
    return { file: path, added, removed };
  }
  if (typeof input.content === "string" && input.content) return { file: path, added: lineCount(input.content), removed: 0 };
  const oldText = input.old_string ?? input.oldString ?? input.old_str
    ?? input.target_content ?? input.TargetContent;
  const newText = input.new_string ?? input.newString ?? input.new_str
    ?? input.replacement_content ?? input.ReplacementContent;
  if (oldText === undefined && newText === undefined) return null;
  return { file: path, added: lineCount(newText), removed: lineCount(oldText) };
}

// Count lines added and removed across turn diffs and tool inputs.
export function countTurnChanges(messages: any[] = []): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;

    const diffs = m.diffs || [];
    for (const d of diffs) {
      const raw = d.patch || d.diff || "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
    }

    const diffFiles = new Set(diffs.map((d: any) => d.file).filter(Boolean));
    for (const t of m.tools || []) {
      if (!WRITE_TOOLS.has(t?.name)) continue;
      const p = t.input?.file_path || t.input?.path || t.input?.file || "";
      if (p && diffFiles.has(p)) continue;
      const c = countToolEdit(t);
      if (c) { added += c.added; removed += c.removed; }
    }
  }
  return { added, removed };
}
