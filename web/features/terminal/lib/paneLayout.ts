// Which panes render, which of those mount, and their join order. Active-workspace panes drive
// tabs/visibility; the LRU union stays mounted so a workspace switch never remounts.

// Sequential join within a freshly-active workspace: focus first (0ms), then stagger the rest
// so concurrent joins don't pile up and stall the main thread.
export const STAGGER_MS = 120;

export const UNGROUPED_KEY = "__ungrouped__";

export interface SessionWithWorkspace {
  id: string;
  workspaceId?: string | null;
  groupId?: string | null;
  [key: string]: any;
}

// Session -> workspace id. Falls back to the legacy groupId while hosts on older
// versions still only send that field.
export const sessionWorkspaceId = (session?: { workspaceId?: string | null; groupId?: string | null } | null): string | null =>
  session?.workspaceId ?? session?.groupId ?? null;

export interface DerivePaneLayoutOptions {
  sessions: SessionWithWorkspace[];
  openedSessions: string[];
  livePanes: string[];
  mountedWorkspaces: Record<string, boolean>;
  activeWorkspaceId: string | null;
  isDesktop: boolean;
}

export interface DerivePaneLayoutResult {
  workspaceSessionIds: Set<string>;
  workspaceOpenedSessions: string[];
  renderedSessions: string[];
  mountedSet: Set<string>;
  workspaceIndex: Map<string, number>;
}

export function derivePaneLayout({
  sessions, openedSessions, livePanes, mountedWorkspaces, activeWorkspaceId, isDesktop
}: DerivePaneLayoutOptions): DerivePaneLayoutResult {
  const workspaceSessionIds = new Set(
    sessions.filter((s) => sessionWorkspaceId(s) === (activeWorkspaceId ?? null)).map((s) => s.id)
  );
  const workspaceOpenedSessions = openedSessions.filter((sid) => workspaceSessionIds.has(sid));
  const liveSet = new Set([
    ...workspaceOpenedSessions,
    ...livePanes.filter((sid) => openedSessions.includes(sid))
  ]);
  const renderedSessions = openedSessions.filter((sid) => liveSet.has(sid));

  // A pane mounts only if its workspace has been visited once (the active workspace auto-marks
  // mounted). Desktop keeps panes from other VISITED workspaces mounted (split/LRU); mobile mounts
  // ONLY the active workspace — one visible pane at a time, keeping others alive wastes memory + joins.
  const sessionWorkspace = new Map(sessions.map((s) => [s.id, sessionWorkspaceId(s)]));
  const mountedSet = new Set(openedSessions.filter((sid) => {
    if (workspaceSessionIds.has(sid)) return true;
    if (!isDesktop) return false;
    return !!mountedWorkspaces[sessionWorkspace.get(sid) ?? UNGROUPED_KEY];
  }));

  const workspaceIndex = new Map(workspaceOpenedSessions.map((sid, i) => [sid, i]));
  return { workspaceSessionIds, workspaceOpenedSessions, renderedSessions, mountedSet, workspaceIndex };
}

// Panes already alive (revisit) join with no delay — their PTY is already running.
export const mountDelayFor = (sessionId: string, isFocused: boolean, workspaceIndex: Map<string, number>): number =>
  !isFocused && workspaceIndex.has(sessionId) ? (workspaceIndex.get(sessionId) ?? 0) * STAGGER_MS : 0;

export interface CenteredPaneScrollOptions {
  container: HTMLElement | null;
  pane: HTMLElement | null;
}

// scrollLeft that centers a pane's slot in the panes row, clamped to what the row can
// actually scroll. A chat pane mounts heavier than a terminal one, so its slot is often
// still being laid out when the focus effect runs.
export function centeredPaneScroll({ container, pane }: CenteredPaneScrollOptions): number | null {
  if (!container || !pane || pane.offsetWidth <= 0) return null;
  const fromRow = pane.getBoundingClientRect().left - container.getBoundingClientRect().left;
  const target = container.scrollLeft + fromRow - (container.clientWidth - pane.offsetWidth) / 2;
  const max = container.scrollWidth - container.clientWidth;
  return Math.max(0, Math.min(target, max));
}

export interface AutoFitPaneWidthOptions {
  rowWidth: number;
  paneCount: number;
  sidebarWidth: number;
  sidePx: number;
  gapPx: number;
  paddingPx: number;
  minWidth: number;
}

// Width an auto-fit pane takes this render. Symmetric: a panel opening narrows the panes
// and a panel closing widens them back, so a transient narrow layout cannot hold the PTY
// at a width it would otherwise only ratchet down from. The resize it drives is debounced
// and skipped when cols/rows come out unchanged (useXTerm), so tracking a panel drag costs
// one re-fit, not one PTY resize per frame.
export function autoFitPaneWidth({
  rowWidth, paneCount, sidebarWidth, sidePx, gapPx, paddingPx, minWidth
}: AutoFitPaneWidthOptions): number | null {
  if (!(rowWidth > 0) || paneCount <= 0) return null;
  const base = rowWidth - sidebarWidth - paddingPx - sidePx;
  return Math.max(minWidth, Math.floor((base - (paneCount - 1) * gapPx) / paneCount));
}
