// Grouping sessions into workspaces for the sidebar, and the display path shown
// next to a workspace name.
import { sessionWorkspaceId, type SessionWithWorkspace } from "./paneLayout";

// "/Users/me/x" -> "~/x". Home is only ever a prefix of a full segment.
export function shortenHomePath(fullPath?: string | null, home?: string | null): string {
  if (!fullPath) return "";
  if (!home) return fullPath;
  if (fullPath === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return fullPath.startsWith(prefix) ? `~/${fullPath.slice(prefix.length)}` : fullPath;
}

export interface WorkspaceItemDef {
  id: string;
  name: string;
  path?: string | null;
  [key: string]: unknown;
}

export interface SessionWorkspaceGroup<T = SessionWithWorkspace> {
  id: string | null;
  name: string;
  path: string | null;
  items: T[];
}

/**
 * Bucket sessions by workspace, in workspace order, with the unassigned ones last.
 * Grouping keys off the session's workspace, never its live cwd — a `cd` inside a
 * terminal must not move it to another workspace.
 */
export function groupSessionsByWorkspace<T extends SessionWithWorkspace>(
  sessions: T[] = [],
  workspaces: WorkspaceItemDef[] = [],
  ungroupedLabel = "Ungrouped"
): SessionWorkspaceGroup<T>[] {
  const buckets = new Map<string | null, T[]>();
  for (const s of sessions) {
    const id = sessionWorkspaceId(s);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(s);
  }

  const ordered: SessionWorkspaceGroup<T>[] = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    path: w.path || null,
    items: buckets.get(w.id) || []
  }));

  const unassigned = buckets.get(null);
  if (unassigned?.length) ordered.push({ id: null, name: ungroupedLabel, path: null, items: unassigned });
  return ordered;
}

// Path a workspace's git state should be read from: its own root, else the fixed
// workspacePath of any session in it (a workspace migrated from a group has no path).
export function workspaceGitPath(workspace?: { path?: string | null; items?: Array<{ workspacePath?: string | null }> } | null): string | null {
  if (workspace?.path) return workspace.path;
  return workspace?.items?.find((s) => s.workspacePath)?.workspacePath || null;
}

// Sibling directory named after the branch — the convention most worktree users follow.
export function suggestWorktreePath(repoPath?: string | null, branch: string = ""): string {
  if (!repoPath) return "";
  const parent = repoPath.slice(0, repoPath.lastIndexOf("/")) || "/";
  const safe = branch.replace(/[^\w.-]+/g, "-");
  return `${parent}/${repoPath.split("/").pop()}-${safe}`;
}
