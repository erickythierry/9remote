// A sub-agent may itself spawn one, so a tool card is the root of a tree, not a flat
// list. Every update has to reach a node at any depth; a top-level-only lookup
// dropped a grandchild's tool calls silently.

export interface ToolInput {
  subagent_type?: string;
  agent?: string;
  description?: string;
  command?: string;
  [key: string]: unknown;
}

export interface ToolNode {
  id: string;
  name?: string;
  status: string;
  input?: ToolInput | string | null;
  children?: ToolNode[];
  async?: boolean;
  timestamp?: number;
  startedAt?: number;
  [key: string]: unknown;
}

export interface AiToolMessage {
  tools?: ToolNode[];
}

export interface HarnessTask {
  status: string;
  background?: boolean;
  toolUseId?: string;
  taskId: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
  startedAt?: number;
  usage?: unknown;
}

export interface AsyncTaskRow {
  kind: "shell" | "agent";
  id?: string;
  taskId?: string;
  label: string;
  startedAt?: number;
  taskType?: string;
  subagentType?: string;
  usage?: unknown;
  toolUseId?: string;
}

// Tools whose row IS a sub-agent. Names are matched exactly: each engine spells them
// its own way, and opencode's is lowercase (`task`), so Claude's `Task` does not cover
// it. Everything else in the agent category (SendMessage, close_agent, wait) is a
// message TO one, not a launch.
export const LAUNCH_TOOLS = new Set([
  "Agent", "Task", "Workflow",   // claude
  "task",                        // opencode
  "browser_subagent", "invoke_subagent", // antigravity
  "spawn_agent",                 // codex
]);

/** A sub-agent's display name: its declared type, or the task it was given. */
export const agentLabel = (tool: ToolNode): string =>
  tool.input && typeof tool.input === "object"
    ? tool.input.subagent_type || tool.input.agent || tool.input.description || "agent"
    : "agent";

/** A shell card's display name: the command it runs, not the word "Bash". */
const shellLabel = (tool: ToolNode): string =>
  tool.input && typeof tool.input === "object"
    ? tool.input.description || (typeof tool.input.command === "string" ? tool.input.command : undefined) || "shell"
    : "shell";

/**
 * Everything launched asynchronously that is still going — the pinned strip's read model.
 *
 * The harness's task set is the authority when it is there (`harnessTasks`, from
 * task_started / background_tasks_changed): the CLI states a task's status, so the strip
 * stops guessing. The tool-row scan below is the FALLBACK for engines that keep no task
 * model of their own — codex and antigravity hand work off without ever saying its name
 * again, and for those the row is all there is.
 */
export function runningAsync(messages: AiToolMessage[] = [], harnessTasks: HarnessTask[] = []): AsyncTaskRow[] {
  if (harnessTasks.length > 0) {
    return harnessTasks
      .filter((task) => task?.status === "running")
      .map((task) => ({
        kind: task.background ? "shell" : "agent",
        // Two ids, deliberately: `id` is what the pane's own rows are keyed by (the tool
        // call), while `taskId` is the name the CLI minted and the only one a stop can
        // address. They coincide on a row the scan produced, and only there is a stop
        // meaningless anyway — nothing on the other side answers to a tool call id.
        id: task.toolUseId || task.taskId,
        taskId: task.taskId,
        label: task.description || task.subagentType || "task",
        // The rest of the harness's own record, passed through for the reader that draws
        // the row: the clock it counts from, what kind of task it is, and what it cost.
        startedAt: task.startedAt,
        taskType: task.taskType,
        subagentType: task.subagentType,
        usage: task.usage,
        toolUseId: task.toolUseId
      }));
  }
  // The scan has no clock to offer: a tool row is stamped by nobody (see harnessTasks —
  // only the CLI's own records carry an age), and inventing one here would print a
  // duration measured from whenever this pane happened to look.
  return scanRunningRows(messages);
}

/** The tool-row fallback: work handed off and never reported on again. */
function scanRunningRows(messages: AiToolMessage[] = []): AsyncTaskRow[] {
  const out: AsyncTaskRow[] = [];
  const walk = (tools: ToolNode[] = []): void => {
    for (const tool of tools) {
      if (tool?.status === "running") {
        const startedAt = tool.startedAt || tool.timestamp;
        const extra = startedAt ? { startedAt } : null;
        if (LAUNCH_TOOLS.has(tool.name || "")) out.push({ kind: "agent", id: tool.id, label: agentLabel(tool), ...extra });
        else if (tool.async) out.push({ kind: "shell", id: tool.id, label: shellLabel(tool), ...extra });
      }
      if (tool?.children?.length) walk(tool.children);
    }
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]?.tools?.length) continue;
    walk(messages[i].tools);
    if (out.length > 0) break;
  }
  return out;
}

/** Every sub-agent still running. */
export function runningAgents(messages: AiToolMessage[] = [], harnessTasks: HarnessTask[] = []): { id?: string; label: string }[] {
  return runningAsync(messages, harnessTasks)
    .filter((row) => row.kind === "agent")
    .map(({ id, label }) => ({ id, label }));
}

/**
 * The tool row a handed-off task lives on, found by the `toolUseId` the CLI named.
 *
 * Returns null when the task is not in the log this pane holds (one announced before the
 * replay window opens), which is a row that draws no activity rather than a wrong one.
 */
export function findTaskTool(messages: AiToolMessage[] = [], toolUseId = ""): ToolNode | null {
  if (!toolUseId) return null;
  let found: ToolNode | null = null;
  const walk = (tools: ToolNode[] = []): boolean => {
    for (const tool of tools) {
      if (tool?.id === toolUseId) {
        found = tool;
        return true;
      }
      if (tool?.children?.length && walk(tool.children)) return true;
    }
    return false;
  };
  for (let i = messages.length - 1; i >= 0 && !found; i--) walk(messages[i]?.tools);
  return found;
}

/**
 * The call a handed-off task is inside RIGHT NOW — the "what is it doing" answer.
 *
 * The pane already has this: a sub-agent's calls are nested under the Agent card that
 * spawned them, and a shell's command is the card itself. So the row is found by the
 * `toolUseId`, then walked DOWN to the deepest running child — a sub-agent three calls
 * deep is doing its fourth, not its first.
 */
export function taskActivity(messages: AiToolMessage[] = [], toolUseId = ""): ToolNode | null {
  const node = findTaskTool(messages, toolUseId);
  if (!node) return null;
  // The deepest still-running call under it; when every step under it has reported done,
  // the LAST of them — a task the harness still calls running is between steps, and an
  // empty "now" line there reads as a broken panel rather than as a pause.
  let leaf = node;
  while (leaf.status === "running") {
    const children = leaf.children || [];
    const next = children.filter((child) => child?.status === "running").pop() || children[children.length - 1];
    if (!next || next === leaf) break;
    leaf = next;
  }
  return leaf;
}

// A turn ended, so nothing this tool had to say is still coming. A row left spinning
// past its turn is wrong in every case; `done` is the least-wrong claim for the ones
// whose result never arrived (codex emits an item.started with no matching
// item.completed when a spawn fails and is retried).
//
// `async` rows are the exception: a sub-agent or background shell was handed off ON
// PURPOSE and goes on working after the turn that launched it ends. The host owns their
// clock instead (AiSession.armAsyncWatchdog) and settles them there. `includeAsync` is
// the dead-process sweep: nothing is left running then, async rows included.
export function settleRunningTools(tools: ToolNode[] | undefined, { includeAsync = false }: { includeAsync?: boolean } = {}): ToolNode[] {
  return (tools || []).map((tool) => {
    const children = tool.children ? settleRunningTools(tool.children, { includeAsync }) : null;
    if (tool.status !== "running" || (tool.async && !includeAsync)) return children ? { ...tool, children } : tool;
    return { ...tool, status: "done", ...(children ? { children } : null) };
  });
}

// Returns a rebuilt array with the first node matching `match` replaced by
// `update(node)`, its ancestors copied along the way — or null when nothing matched,
// which is how a caller tells "no such card here" from "updated, look elsewhere".
export function updateToolTree(
  tools: ToolNode[] | undefined,
  match: (tool: ToolNode) => boolean,
  update: (tool: ToolNode) => ToolNode
): ToolNode[] | null {
  let changed = false;
  const next = (tools || []).map((tool) => {
    if (match(tool)) {
      changed = true;
      return update(tool);
    }
    const children = updateToolTree(tool.children, match, update);
    if (!children) return tool;
    changed = true;
    return { ...tool, children };
  });
  return changed ? next : null;
}
