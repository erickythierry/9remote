// Fleet view pure helpers: nest a host's flat session list under its workspaces
// (ungrouped bucket last, same order SessionList shows) and count the summary a
// collapsed host card displays. Dependency-free so the test runs under plain node.

export interface FleetSession {
  id: string;
  workspaceId?: string | null;
  [key: string]: unknown;
}

export interface FleetWorkspace {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface FleetHost {
  key: string;
  label?: string;
  sessions?: FleetSession[];
  workspaces?: FleetWorkspace[];
  [key: string]: unknown;
}

export interface HostTreeNode {
  workspace: FleetWorkspace | null;
  sessions: FleetSession[];
}

export function hostTree(sessions: FleetSession[] = [], workspaces: FleetWorkspace[] = []): HostTreeNode[] {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const buckets = new Map<string | null, FleetSession[]>();
  for (const session of sessions) {
    const id = known.has(session.workspaceId || "") ? session.workspaceId! : null;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(session);
    else buckets.set(id, [session]);
  }
  return [
    // An empty workspace still renders — it is the affordance that carries the
    // "create terminal here" row; hiding it made a fresh workspace invisible.
    ...workspaces.map((workspace) => ({ workspace, sessions: buckets.get(workspace.id) || [] })),
    ...(buckets.has(null) ? [{ workspace: null, sessions: buckets.get(null)! }] : [])
  ];
}

// States mirror statusManager's 4-state map (idle/working/blocked/done).
export function hostSummary(
  sessions: FleetSession[] = [],
  statusMap: Record<string, { state?: string }> = {}
): { sessions: number; working: number; attention: number } {
  let working = 0;
  let attention = 0;
  for (const session of sessions) {
    const state = statusMap[session.id]?.state;
    if (state === "working") working++;
    else if (state === "blocked" || state === "done") attention++;
  }
  return { sessions: sessions.length, working, attention };
}

// Workspace ids cross the host boundary as "head:rawId" (scopedFleetLists). These
// are the two directions a tree or nav needs.
export const scopedWsId = (head: string, rawId: string): string => `${head}:${rawId}`;
// Cache namespace per host: "" = the main host (legacy keys stay untouched),
// "@head" = a fleet host. Every localStorage cache that holds host-owned data
// (recents, browsed dir, agent history) keys through this.
export const scopeOf = (head: string | null | undefined): string => (head ? `@${head}` : "");
export const rawWsIdOf = (scopedId: unknown, head: string): string | null => (
  typeof scopedId === "string" && scopedId.startsWith(`${head}:`)
    ? scopedId.slice(head.length + 1)
    : null
);

// The RAW workspace id a tree should highlight for `scopedId`, or undefined when
// the active workspace belongs to some other host ("_" = the synthetic ungrouped).
export function activeWsForHost(scopedId: unknown, head: string): string | null | undefined {
  const raw = rawWsIdOf(scopedId, head);
  if (raw === null) return undefined;
  return raw === "_" ? null : raw;
}

// "seen 2d"-style relative time, shared by the fleet view and the sidebar's
// other-host roots.
export function relTime(ts: number | null | undefined, t: (key: string, values?: { n: number }) => string): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return t("login.justNow");
  if (m < 60) return t("login.minutesAgo", { n: m });
  if (h < 24) return t("login.hoursAgo", { n: h });
  if (d < 7) return t("login.daysAgo", { n: d });
  return new Date(ts).toLocaleDateString();
}

// Every host root in ADD order (the store's insertion order — sync() builds it
// from the saved-key list). Equal siblings: the current host's tree renders at
// its own spot, no login-based sorting. Before the fleet settles, a synthetic
// "main" entry keeps the current tree visible next to whatever is known.
export function orderedHostsOf(hosts: FleetHost[], currentKey: string | null | undefined): FleetHost[] {
  const mainKey = currentKey || "main";
  return hosts.some((host) => host.key === mainKey) ? hosts : [{ key: "main" }, ...hosts];
}

// Other hosts' sessions/workspaces re-keyed under "head:" so they flow through the
// existing workspace model untouched — scoped ids can never collide with the main
// host's, and foreign ungrouped sessions get a named group instead of mixing into
// the main host's ungrouped bucket.
export function scopedFleetLists(hosts: FleetHost[], currentKey: string | null | undefined): { sessions: FleetSession[]; workspaces: FleetWorkspace[] } {
  const out: { sessions: FleetSession[]; workspaces: FleetWorkspace[] } = { sessions: [], workspaces: [] };
  if (!currentKey) return out;
  for (const host of hosts) {
    if (host.key === currentKey) continue;
    const prefix = `${host.key}:`;
    const ungroupedId = `${prefix}_`;
    const hasUngrouped = (host.sessions || []).some((session) => session.workspaceId == null);
    for (const workspace of host.workspaces || []) {
      out.workspaces.push({ ...workspace, id: prefix + workspace.id, hostKey: host.key });
    }
    if (hasUngrouped) {
      out.workspaces.push({ id: ungroupedId, name: host.label || host.key, hostKey: host.key });
    }
    for (const session of host.sessions || []) {
      out.sessions.push({
        ...session,
        workspaceId: session.workspaceId != null ? prefix + session.workspaceId : ungroupedId,
        hostKey: host.key
      });
    }
  }
  return out;
}
