// Turn read model: arrival-ordered row list split into renderable blocks.

import { getToolCategory, getEngineConfig } from "../registry.js";

// Tools rendered in pinned checklist strip rather than inline.
const TASK_STRIP_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "todowrite"]);

// Engines whose question gate renders pinned above the composer — declared per engine in
// the registry (questionGate). Elsewhere a running question stays in the timeline as a
// plain row: headless engines cannot be answered, but the ask must stay visible while it
// blocks. opencode is in on both counts: the poller pins the card from its /question store,
// and the ask is also a `question` tool part the poller turns into a row (the card would
// double it).
const questionGate = (engine: string) => Boolean(getEngineConfig(engine)?.questionGate);

// Diff-emitting tools across agent adapters (hidden inline to prevent duplicate file cards).
const DIFF_TOOL_NAMES = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit", "file_change",
  "edit", "write", "write_to_file", "replace_file_content"
]);
// Normalize target file path across tool schemas.
const editTarget = (input: any = {}) => input.file_path || input.notebook_path || input.path || input.filePath || input.file || "";

export const editsFile = (t: any, path: string) =>
  DIFF_TOOL_NAMES.has(t?.name) && path &&
  ((t.input?.paths || []).includes(path) || editTarget(t.input) === path);

export function visibleTools(engine: string, tools?: any[], diffs?: any[]) {
  return (tools || []).filter((t: any) => {
    if (!t || !t.name) return false;
    if ((diffs || []).some((d: any) => d.file && editsFile(t, d.file))) return false;
    if (getToolCategory(engine, t.name) === "task" && TASK_STRIP_TOOLS.has(t.name)) return false;
    return true;
  });
}

export interface TurnRow {
  kind: "notice" | "thought" | "tool" | "diff" | "prose" | "permission";
  id: string;
  notice?: any;
  text?: string;
  tool?: any;
  engine?: string;
  diff?: any;
  content?: string;
  isLive?: boolean;
  permission?: any;
}

export function buildTurnRows(messages: any[] = [], engine: string = "claude"): TurnRow[] {
  const rows: TurnRow[] = [];
  // Deduplicate repeated tool call ids across segments.
  const seenToolIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "notice") {
      rows.push({
        kind: "notice", id: m.id,
        notice: {
          subtype: m.subtype, level: m.level, content: m.content,
          ...(m.compact ? { compact: m.compact } : null),
          ...(m.compacting ? { compacting: true } : null)
        }
      });
      continue;
    }
    if (m.role !== "assistant") continue;
    if (m.thinking?.trim()) rows.push({ kind: "thought", id: `${m.id}-th`, text: m.thinking });

    const tools = visibleTools(engine, m.tools, m.diffs);
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      if (getToolCategory(engine, t.name) === "question" && t.status === "running" && questionGate(engine)) continue;
      const id = t.id || `${m.id}-t${i}`;
      if (seenToolIds.has(id)) continue;
      seenToolIds.add(id);
      rows.push({ kind: "tool", id, tool: t, engine });
    }

    for (let i = 0; i < (m.diffs?.length || 0); i++) {
      const d = m.diffs[i];
      rows.push({ kind: "diff", id: `${m.id}-d${i}`, diff: d });
    }

    if (m.content) rows.push({ kind: "prose", id: `${m.id}-p`, content: m.content, isLive: m.isLive });
    if (m.permission) rows.push({ kind: "permission", id: `${m.id}-perm`, permission: m.permission });
  }
  return rows;
}

const isStep = (r: TurnRow) => r.kind === "thought" || r.kind === "tool" || r.kind === "diff";

export function hiddenCount(total: number, windowSize: number, revealed: number = 0) {
  const rest = total - Math.max(0, revealed);
  return rest > windowSize + 1 ? rest - windowSize : 0;
}

export function revealStep(hidden: number, chunk: number) {
  return Math.min(chunk, Math.max(0, hidden));
}

export function collapseStep(revealed: number, chunk: number) {
  return Math.min(chunk, Math.max(0, revealed));
}

export interface TurnBlock {
  type: "steps" | "row";
  key?: string;
  rows?: TurnRow[];
  row?: TurnRow;
  hidden?: number;
  deferred?: boolean;
}

export function splitTurnBlocks(rows: TurnRow[] = [], windowSize: number = 6, { deferred = false }: { deferred?: boolean } = {}): TurnBlock[] {
  const blocks: { type: "steps" | "row"; rows?: TurnRow[]; row?: TurnRow }[] = [];
  for (const row of rows) {
    if (isStep(row)) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "steps" && last.rows) last.rows.push(row);
      else blocks.push({ type: "steps", rows: [row] });
    } else {
      blocks.push({ type: "row", row });
    }
  }
  return blocks.map((b, i) => {
    if (b.type !== "steps") return { ...b, key: `r${i}`, deferred };
    const rowsList = b.rows || [];
    const hidden = rowsList.length > windowSize + 1 ? rowsList.length - windowSize : 0;
    return { type: "steps", key: `s${i}`, rows: rowsList, hidden, deferred };
  });
}
