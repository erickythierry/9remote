// group -> workspace migration + git-root discovery.
// Kept free of PATHS/IO wiring so it can be unit-tested with an injected fs.
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

// How far up from a session cwd we look for a .git before giving up.
const GIT_ROOT_MAX_DEPTH = 24;
type PathIo = { existsSync: typeof fs.existsSync };
type SessionRecord = { cwd?: string | null; workspacePath?: string | null; createdAt?: number };
type LegacyGroup = { id?: string; name?: string; path?: string; createdAt?: number };
type LegacyState = { groups?: LegacyGroup[]; sessionGroups?: Record<string, string>; sessionOrder?: string[] };
type Workspace = { id: string; name: string; path: string; createdAt: number };
type SessionEntries = Array<[string, SessionRecord]>;

function sessionEntries(sessions: Map<string, SessionRecord> | Record<string, SessionRecord>): SessionEntries {
  return sessions instanceof Map ? [...sessions.entries()] : Object.entries(sessions || {});
}

// Nearest ancestor directory (cwd included) holding a .git entry. null when none.
export function findGitRoot(cwd: string | null | undefined, io: PathIo = fs): string | null {
  if (!cwd || typeof cwd !== "string") return null;
  let dir = path.resolve(cwd);
  for (let i = 0; i < GIT_ROOT_MAX_DEPTH; i++) {
    try {
      if (io.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export const workspaceNameFromPath = (p: string): string =>
  path.basename(p) || p;

// Deterministic id so re-running migration never duplicates a workspace for the same path.
// Hashed, not truncated: two deep paths sharing a long prefix (a temp dir, a monorepo)
// would collide if the encoded path were simply cut short.
export const workspaceIdForPath = (p: string): string =>
  `ws_${createHash("sha1").update(path.resolve(p)).digest("hex").slice(0, 16)}`;

// Deepest directory containing every one of the given paths. Used to turn a group whose
// terminals sit in the same tree into a workspace rooted at that tree.
export function commonAncestor(paths: string[] = []): string | null {
  const usable = paths.filter(Boolean).map((p) => path.resolve(p));
  if (!usable.length) return null;
  let parts = usable[0].split(path.sep);
  for (const p of usable.slice(1)) {
    const other = p.split(path.sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  const joined = parts.join(path.sep);
  // A single leading "" means we walked back to the filesystem root — too broad to be a
  // useful workspace, so treat it as "no common root".
  if (!joined || joined === "" || parts.filter(Boolean).length === 0) return null;
  return joined;
}

// The path a set of sessions should root at: their shared git repo if they agree on one,
// else the deepest directory they all live under.
export function rootForSessions(sessionList: SessionRecord[], io: PathIo = fs): string | null {
  const cwds = sessionList.map((s) => s?.workspacePath || s?.cwd).filter((cwd): cwd is string => Boolean(cwd));
  if (!cwds.length) return null;

  const repos = new Set<string>();
  for (const cwd of cwds) {
    const repo = findGitRoot(cwd, io);
    if (repo) repos.add(path.resolve(repo));
  }
  if (repos.size === 1) return [...repos][0];
  if (repos.size > 1) return commonAncestor([...repos]);
  return commonAncestor(cwds);
}

/**
 * Build the workspace state from legacy group state plus live session cwds.
 *
 * Every workspace comes out with a real path — a path-less workspace would show an empty
 * file tree and no git, which is worse than the group it replaced. A group's path is
 * inferred from where its own terminals are; an ungrouped session gets the workspace of
 * its nearest git root, else of its own directory.
 *
 * @param {{groups?:Array, sessionGroups?:Object, sessionOrder?:Array}} legacy
 * @param {Map<string,{cwd?:string}>|Object} sessions
 * @returns {{workspaces:Array, sessionWorkspaces:Object, sessionPaths:Object, sessionOrder:Array}}
 */
export function migrateGroupsToWorkspaces(legacy: LegacyState = {}, sessions: Map<string, SessionRecord> | Record<string, SessionRecord> = new Map(), io: PathIo = fs): { workspaces: Workspace[]; sessionWorkspaces: Record<string, string>; sessionPaths: Record<string, string>; sessionOrder: string[] } {
  const entries = sessionEntries(sessions);
  const sessionById = new Map<string, SessionRecord>(entries);

  const byId = new Map<string, Workspace>();
  const byPath = new Map<string, string>();
  const sessionWorkspaces: Record<string, string> = {};

  const claimPath = (resolved: string, name: string | null, createdAt: number | undefined, preferredId?: string): string => {
    const existing = byPath.get(resolved);
    if (existing) return existing;
    const id = preferredId || workspaceIdForPath(resolved);
    byPath.set(resolved, id);
    byId.set(id, { id, name: name || workspaceNameFromPath(resolved), path: resolved, createdAt: createdAt || Date.now() });
    return id;
  };

  // Legacy groups first, so their user-chosen names survive.
  for (const g of legacy.groups || []) {
    if (!g?.id) continue;
    const members = Object.entries(legacy.sessionGroups || {})
      .filter(([, gid]) => gid === g.id)
      .map(([sid]) => sessionById.get(sid))
      .filter((session): session is SessionRecord => Boolean(session));

    const root = g.path ? path.resolve(g.path) : rootForSessions(members, io);
    // A group whose terminals are all gone leaves nothing to infer a path from; drop it
    // rather than keep a workspace that can never show a tree.
    if (!root) continue;

    const id = claimPath(root, g.name || g.id, g.createdAt, g.id);
    for (const [sid, gid] of Object.entries(legacy.sessionGroups || {})) {
      if (gid === g.id && sessionById.has(sid)) sessionWorkspaces[sid] = id;
    }
  }

  // Then everything still unassigned, by its own git root (or its own directory).
  for (const [sessionId, session] of entries) {
    if (sessionWorkspaces[sessionId]) continue;
    const root = rootForSessions([session], io);
    if (!root) continue;
    sessionWorkspaces[sessionId] = claimPath(root, null, session?.createdAt);
  }

  // Pin each session to its workspace root so a later `cd` cannot move it.
  const sessionPaths: Record<string, string> = {};
  for (const [sessionId, workspaceId] of Object.entries(sessionWorkspaces)) {
    const wsPath = byId.get(workspaceId)?.path;
    if (wsPath) sessionPaths[sessionId] = wsPath;
  }

  // Keep only ids we still know about; migration must never invent order entries.
  const knownSessions = new Set(entries.map(([id]) => id));
  const sessionOrder = (legacy.sessionOrder || []).filter((id) => knownSessions.has(id));

  return { workspaces: [...byId.values()], sessionWorkspaces, sessionPaths, sessionOrder };
}

/**
 * Place sessions that belong to no workspace. Each one joins the workspace whose path is
 * its own git root; failing that, sessions sharing a directory are pooled into a new
 * workspace at that directory. A session with nowhere to go is left alone rather than
 * swept into a catch-all that would mean nothing.
 *
 * Runs on every startup, not once: terminals created against an older agent, or moved by
 * a `cd` before their workspace existed, keep arriving.
 *
 * @returns {{assignments: Object, created: Array}} sessionId -> workspaceId, and any new
 *   workspaces the caller still has to register.
 */
export function assignOrphanSessions({ sessions, workspaces, sessionWorkspaces }: { sessions: Map<string, SessionRecord> | Record<string, SessionRecord>; workspaces: Workspace[]; sessionWorkspaces: Record<string, string> }, io: PathIo = fs): { assignments: Record<string, string>; created: Workspace[] } {
  const entries = sessionEntries(sessions);
  const orphans = entries.filter(([id]) => !sessionWorkspaces?.[id]);
  if (!orphans.length) return { assignments: {}, created: [] };

  const byPath = new Map<string, string>();
  for (const w of workspaces || []) {
    if (w?.path) byPath.set(path.resolve(w.path), w.id);
  }

  const assignments: Record<string, string> = {};
  const created: Workspace[] = [];
  const pending = new Map<string, Array<{ sessionId: string; session: SessionRecord }>>();

  for (const [sessionId, session] of orphans) {
    const root = rootForSessions([session], io);
    if (!root) continue;
    const resolved = path.resolve(root);

    // An existing workspace wins outright; no new one is invented for a path we know.
    const existing = byPath.get(resolved);
    if (existing) {
      assignments[sessionId] = existing;
      continue;
    }
    if (!pending.has(resolved)) pending.set(resolved, []);
    pending.get(resolved)!.push({ sessionId, session });
  }

  for (const [root, members] of pending) {
    const id = workspaceIdForPath(root);
    created.push({
      id,
      name: workspaceNameFromPath(root),
      path: root,
      createdAt: Math.min(...members.map((m) => m.session?.createdAt || Date.now()))
    });
    for (const { sessionId } of members) assignments[sessionId] = id;
  }

  return { assignments, created };
}
