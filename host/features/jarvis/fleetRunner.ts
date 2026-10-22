import type { FleetAi, FleetPty } from "./fleetSnapshot.js";
// The live data behind list_fleet: daemon PTY facts + AI manager state + a git
// probe per unique cwd, folded through the pure buildFleetSnapshot.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonSessionSummary, listSessions } from "../terminal/ptyDaemonClient.js";
import { globalAiManager } from "../ai/aiManager.js";
import { listSessionRoots } from "../terminal/terminalSocket.js";
import { buildFleetSnapshot } from "./fleetSnapshot.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2000;

// One probe per unique cwd: branch name + whether this checkout is a worktree.
// Async on purpose — the agent is streaming terminal/video while Jarvis asks,
// and a sync spawn would freeze every pane for the probe's whole duration.
async function gitFacts(cwd: string) {
  const run = (args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS, encoding: "utf8" });
  try {
    const [branch, gitDir, commonDir] = await Promise.all([
      run(["rev-parse", "--abbrev-ref", "HEAD"]),
      run(["rev-parse", "--git-dir"]),
      run(["rev-parse", "--git-common-dir"])
    ]);
    const name = branch.stdout.trim();
    return { branch: name === "HEAD" ? null : name, worktree: gitDir.stdout.trim() !== commonDir.stdout.trim() };
  } catch {
    // Anything but a clean answer means "not a repo" — the row carries no branch.
    return { branch: null, worktree: false };
  }
}

// Each session's workspace (the folder its tab was opened under). PTY-backed
// sessions carry it directly; a headless AI pane inherits the deepest root that
// contains its cwd, so a chat in /repo/web belongs to the /repo workspace.
function workspaceBySession() {
  const byId = new Map<string, string | null>();
  const roots = listSessionRoots();
  for (const row of roots) {
    if (row?.id) byId.set(row.id, row.workspacePath || row.cwd || null);
  }
  return { byId, roots: roots.map((r) => r.workspacePath || r.cwd).filter((p): p is string => Boolean(p)) };
}

const under = (cwd: string | null | undefined, root: string) => cwd && root && (cwd === root || cwd.startsWith(root + "/"));
function workspaceForCwd(cwd: string | null | undefined, rootPaths: string[]) {
  let best: string | null = null;
  for (const root of rootPaths) {
    if (under(cwd, root) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

export async function fleetSnapshot() {
  let ptySessions: DaemonSessionSummary[] = [];
  try { ptySessions = await listSessions(); } catch { /* daemon down: AI rows still go out */ }
  const ws = workspaceBySession();

  const aiSessions: FleetAi[] = [...globalAiManager.sessions.values()].map((s) => ({
    id: s.id,
    engine: s.engine,
    cwd: s.cwd,
    isTurnRunning: !!s.isTurnRunning,
    activePermission: s.pendingPermission ? s.pendingPermission() : null,
    lastPrompt: s.lastPrompt || ""
  }));

  const rows: FleetPty[] = [...ptySessions, ...aiSessions];
  const cwds = [...new Set(rows.map((r) => r?.cwd).filter((cwd): cwd is string => Boolean(cwd)))];
  const probes = await Promise.all(cwds.map(async (cwd) => [cwd, await gitFacts(cwd)] as const));
  const probed = new Map(probes);

  const branches: Record<string, string> = {};
  const worktrees: Record<string, boolean> = {};
  const workspacePaths: Record<string, string | null> = {};
  for (const row of rows) {
    if (!row?.id || !row.cwd) continue;
    const facts = probed.get(row.cwd);
    if (!facts) continue;
    if (facts.branch) branches[row.id] = facts.branch;
    if (facts.worktree) worktrees[row.id] = true;
  }
  for (const row of rows) {
    if (!row?.id) continue;
    workspacePaths[row.id] = ws.byId.get(row.id)
      || workspaceForCwd(row.cwd, ws.roots)
      || null;
  }

  return buildFleetSnapshot({ ptySessions, aiSessions, branches, worktrees, workspacePaths });
}
