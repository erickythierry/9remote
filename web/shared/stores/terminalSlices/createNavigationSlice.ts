import { MAX_LIVE_PANES } from "@/features/terminal/constants/terminalConfig";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer.js";
import { UNGROUPED_KEY } from "@/features/terminal/lib/paneLayout";
import { OVERLAY_VIEWS, type WorkspaceView } from "@/features/terminal/constants/routeConfig";
import type { AgentHistoryRow, NavigationSlice, TerminalStoreState } from "../terminalTypes";

type SliceSet = (partial: Partial<TerminalStoreState> | ((state: TerminalStoreState) => Partial<TerminalStoreState>)) => void;
type SliceGet = () => TerminalStoreState;

const staleAgentHistory = (
  history: Record<string, { at: number; sessions: AgentHistoryRow[] }>,
  mapRow?: (row: AgentHistoryRow) => AgentHistoryRow
): Record<string, { at: number; sessions: AgentHistoryRow[] }> => {
  const next: Record<string, { at: number; sessions: AgentHistoryRow[] }> = {};
  for (const [cwd, entry] of Object.entries(history)) {
    next[cwd] = { at: 0, sessions: mapRow ? entry.sessions.map(mapRow) : entry.sessions };
  }
  return next;
};

const isOverlay = (view: WorkspaceView | undefined): boolean => !!view && OVERLAY_VIEWS.includes(view.type);

export const createNavigationSlice = (set: SliceSet, get: SliceGet): NavigationSlice => ({
  // Navigation stack
  viewStack: [{ type: "list" }],
  openedSessions: [],

  // Active workspace
  activeWorkspaceId: null,
  setActiveWorkspaceId: (workspaceId) => set((state) => ({
    activeWorkspaceId: workspaceId,
    fullMode: !!state.fullModes?.[workspaceId ?? UNGROUPED_KEY]
  })),

  // LRU live panes
  livePanes: [],
  touchLivePane: (sessionIds) => set((state) => {
    const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
    const next = [...state.livePanes.filter(id => !ids.includes(id)), ...ids];
    return { livePanes: next.slice(-MAX_LIVE_PANES) };
  }),

  // Mounted workspaces
  mountedWorkspaces: {},
  markWorkspaceMounted: (workspaceId) => set((state) => {
    const key = workspaceId ?? UNGROUPED_KEY;
    if (state.mountedWorkspaces[key]) return state;
    return { mountedWorkspaces: { ...state.mountedWorkspaces, [key]: true } };
  }),
  isWorkspaceMounted: (workspaceId) => {
    const key = workspaceId ?? UNGROUPED_KEY;
    return !!get().mountedWorkspaces[key];
  },

  // Drafts
  drafts: {},
  setDraft: (sessionId, text) => set((state) => ({
    drafts: { ...state.drafts, [sessionId]: text }
  })),

  // Collapsed workspaces
  collapsedWorkspaces: {},
  toggleWorkspace: (key) => set((state) => ({
    collapsedWorkspaces: { ...state.collapsedWorkspaces, [key]: !state.collapsedWorkspaces[key] }
  })),

  // CWD by session
  cwdBySession: {},
  setCwd: (sessionId, cwd) => {
    if (!sessionId || !cwd) return;
    const norm = toPosixPath(cwd) as string;
    set((state) => state.cwdBySession[sessionId] === norm ? state : ({ cwdBySession: { ...state.cwdBySession, [sessionId]: norm } }));
  },

  // View stack actions
  pushView: (view) => set((state) => {
    const stack = Array.isArray(state.viewStack) ? state.viewStack : [];
    const overlay = isOverlay(view);
    const base = overlay
      ? stack
      : stack.filter((v, i) => !(isOverlay(v) && i === stack.length - 1));
    // Re-raising the SAME overlay (browser tab clicked twice) replaces the top
    // entry — appending would make Back step through duplicates. Non-overlay
    // views keep the historical append semantics untouched.
    if (overlay && base.length && base[base.length - 1]?.type === view.type) {
      const next = [...base];
      next[next.length - 1] = view;
      return { viewStack: next };
    }
    return { viewStack: [...base, view] };
  }),

  popView: () => set((state) => {
    const stack = Array.isArray(state.viewStack) ? state.viewStack : [];
    return {
      viewStack: stack.length > 1 ? stack.slice(0, -1) : [{ type: "list" }]
    };
  }),

  setViewStack: (viewStack) => set({ viewStack }),

  addOpenedSession: (sessionId) => set((state) => ({
    openedSessions: state.openedSessions.includes(sessionId)
      ? state.openedSessions
      : [...state.openedSessions, sessionId]
  })),

  removeOpenedSession: (sessionId) => set((state) => {
    const { [sessionId]: _, ...drafts } = state.drafts;
    const { [sessionId]: __, ...startups } = state.pendingStartup;
    const { [sessionId]: ___, ...artifacts } = state.artifactsBySession;
    return {
      artifactsBySession: artifacts,
      openedSessions: state.openedSessions.filter(id => id !== sessionId),
      livePanes: state.livePanes.filter(id => id !== sessionId),
      hiddenPaneSessionIds: state.hiddenPaneSessionIds ? state.hiddenPaneSessionIds.filter((id) => id !== sessionId) : [],
      drafts,
      pendingStartup: startups
    };
  }),

  // A chat pane's "+" swaps one session id for another IN PLACE: the pane keeps its
  // slot in the row, so the pane count never changes and nothing re-measures the
  // pane width or re-centers the row — add-then-remove flashed and scrolled instead.
  replaceOpenedSession: (oldId, newId) => set((state) => {
    if (!newId || oldId === newId) return state;
    const swap = (id: string) => (id === oldId ? newId : id);
    // The close of the old terminal can beat the create's ack, in which case its slot
    // is already gone — the new pane must still open rather than have no row at all.
    const opened = !oldId || state.openedSessions.includes(oldId)
      ? state.openedSessions.map(swap)
      : (state.openedSessions.includes(newId) ? state.openedSessions : [...state.openedSessions, newId]);
    return {
      openedSessions: opened,
      livePanes: state.livePanes.map(swap)
    };
  }),

  clearOpenedSessions: () => set({ openedSessions: [], livePanes: [] }),

  reorderOpenedSessions: (orderedIds) => set((state) => {
    const moving = new Set(orderedIds);
    const queue = orderedIds.filter((id) => state.openedSessions.includes(id));
    if (queue.length < 2) return {};
    let i = 0;
    return {
      openedSessions: state.openedSessions.map((id) => (moving.has(id) ? queue[i++] : id))
    };
  }),

  closeSession: (sessionId) => set((state) => {
    const { [sessionId]: _draft, ...drafts } = state.drafts;
    const { [sessionId]: _startup, ...pendingStartup } = state.pendingStartup;
    const { [sessionId]: _agent, ...agentBySession } = state.agentBySession;
    const agentHistory = staleAgentHistory(state.agentHistory, (row) =>
      row.openSessionId === sessionId ? { ...row, openSessionId: null } : row
    );
    return {
      openedSessions: state.openedSessions.filter(id => id !== sessionId),
      livePanes: state.livePanes.filter(id => id !== sessionId),
      drafts,
      pendingStartup,
      agentBySession,
      agentHistory
    };
  }),

  getCurrentView: () => {
    const { viewStack } = get();
    return viewStack[viewStack.length - 1];
  },

  getSelectedSession: () => {
    const { viewStack } = get();
    for (let i = viewStack.length - 1; i >= 0; i--) {
      const view = viewStack[i];
      if (view.type === "terminal") return view.sessionId;
    }
    return null;
  },

  reset: () => set({
    viewStack: [{ type: "list" }],
    openedSessions: [],
    livePanes: [],
    activeWorkspaceId: null
  })
});
