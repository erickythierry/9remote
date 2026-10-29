"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "@/shared/i18n";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFileManagerStore } from "@/shared/stores/fileManagerStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { makeFleetActions } from "@/features/hosts/lib/fleetActions";
import { agentLaunchCommand, applySkipPermissions } from "@/features/terminal/constants/agentCli";
import { OPEN_SESSION_EVENT } from "@/features/terminal/constants/terminalConfig";
import { OVERLAY_VIEWS, type WorkspaceView } from "@/features/terminal/constants/routeConfig";
import type { AgentConfig, CreateSession } from "@/features/session/hooks/useAgentBus";

interface SessionRecord {
  id: string;
  cwd?: string | null;
  workspaceId?: string | null;
  hostKey?: string | null;
}

interface AgentHistoryRow {
  resume?: string | null;
  mode?: string;
  agent?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
}

interface NavigationOptions {
  sessions: SessionRecord[];
  currentView: WorkspaceView;
  viewStack: WorkspaceView[];
  setViewStack: (stack: WorkspaceView[]) => void;
  pushView: (view: WorkspaceView) => void;
  storePopView: () => void;
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (workspaceId: string | null) => void;
  activeSessionId: string | null;
  addOpenedSession: (sessionId: string) => void;
  removeOpenedSession: (sessionId: string) => void;
  touchLivePane: (sessionIds: string | string[]) => void;
  createSession: CreateSession;
  deleteSession: (sessionId: string, callback: () => void) => void;
  renameSession: (sessionId: string, name: string, callback: (result: { success: boolean; error?: string }) => void) => void;
  busRef: { current: { emit: (event: string, payload: unknown, callback?: () => void) => void } | null };
  isDesktop?: boolean;
  requestFocus?: ((sessionId: string) => void) | null;
}

// Session/workspace navigation: select, create, delete, rename, and the workspace-aware
// tab cycling used by the PC input bar.
export function useSessionNavigation({
  sessions, currentView, viewStack, setViewStack, pushView, storePopView,
  activeWorkspaceId, setActiveWorkspaceId, activeSessionId,
  addOpenedSession, removeOpenedSession, touchLivePane,
  createSession, deleteSession, renameSession, busRef,
  isDesktop = false, requestFocus = null
}: NavigationOptions) {
  const { t } = useI18n();

  // Replace the top of the stack with a terminal view for this session
  const replaceTopWithSession = useCallback((sessionId: string) => {
    const newStack = [...viewStack];
    newStack[newStack.length - 1] = { type: "terminal", sessionId };
    setViewStack(newStack);
  }, [viewStack, setViewStack]);

  // Session ids belonging to a workspace, in list order
  const workspaceSessionIds = useCallback(
    (workspaceId: string | null) => sessions.filter((s) => sessionWorkspaceId(s) === (workspaceId ?? null)).map((s) => s.id),
    [sessions]
  );

  const alertCreateFailed = useCallback(
    (error: string | undefined) => alert(t("workspace.failedCreateSession", { error })),
    [t]
  );

  // Entering terminal view: open sessions of the selected session's workspace, set it active.
  // Selecting a pane does NOT mark its done badge read — only typing/sending into it does.
  const handleSelectSession = useCallback((sessionId: string, pendingWorkspaceId?: string | null) => {
    const selected = sessions.find(s => s.id === sessionId);
    // A caller can hold an id that has since closed (a history row, a stale
    // notification): pushing a view for it renders an empty terminal that no
    // longer has anything behind it. `pendingWorkspaceId` exempts an id the list
    // has not absorbed yet — a session created this same tick (fleet create), whose
    // workspace the caller hands over in scoped form.
    if (!selected && pendingWorkspaceId === undefined) return;
    const workspaceId = (selected ? sessionWorkspaceId(selected) : pendingWorkspaceId) ?? null;
    setActiveWorkspaceId(workspaceId);
    useFileManagerStore.getState().setActive(workspaceId ?? "default", null);
    const ids = workspaceSessionIds(workspaceId);
    ids.forEach(id => addOpenedSession(id));
    addOpenedSession(sessionId);
    touchLivePane([...ids, sessionId]); // keep this workspace's panes alive (LRU)

    if (currentView.type === "terminal") replaceTopWithSession(sessionId);
    else pushView({ type: "terminal", sessionId });
    if (!selected) requestFocus?.(sessionId); // a just-created pane takes focus, like the main-host flows
  }, [
    sessions, workspaceSessionIds, addOpenedSession, touchLivePane, setActiveWorkspaceId,
    currentView, pushView, replaceTopWithSession, requestFocus
  ]);

  // Deep-link from a push notification tap (SW postMessage) or OS Dock icon click
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "NOTIFICATION_CLICK") return;
      const sid = new URLSearchParams(new URL(e.data.url || "", location.origin).search).get("t");
      if (sid) handleSelectSession(sid);
    };

    const onDockClick = () => {
      const activeNotifs = useNotificationStore.getState().notifications;
      // Only sessions waiting on the user hijack the dock click — a lingering "done"
      // badge (cleared only by typing into it) must not pull the view into its tab.
      const entries = Object.values(activeNotifs || {}).filter((n) => n.type === "blocked");
      if (!entries.length) return;

      const inCurrentWorkspace = (sId: string) => {
        const sess = sessions.find((s) => s.id === sId);
        return sess && sessionWorkspaceId(sess) === (activeWorkspaceId ?? null);
      };

      const sorted = entries.sort((a, b) => {
        // 1. Prioritize active/focused workspace first
        const aCur = inCurrentWorkspace(a.sessionId);
        const bCur = inCurrentWorkspace(b.sessionId);
        if (aCur && !bCur) return -1;
        if (!aCur && bCur) return 1;

        // 2. Latest timestamp
        return (b.timestamp || 0) - (a.timestamp || 0);
      });

      const target = sorted[0];
      if (target?.sessionId) {
        handleSelectSession(target.sessionId);
      }
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("9remote:dock-click", onDockClick);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("9remote:dock-click", onDockClick);
    };
  }, [handleSelectSession, sessions, activeWorkspaceId]);

  // A past-conversation row that a terminal is already running focuses that terminal
  // instead of resuming a second copy. Same door as the dock click above.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const sessionId = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sessionId) handleSelectSession(sessionId);
    };
    window.addEventListener(OPEN_SESSION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, onOpen);
  }, [handleSelectSession]);

  // Tab/Shift+Tab in the PC input bar cycles sessions within the active workspace (wrap-round)
  const switchSession = useCallback((direction: "prev" | "next") => {
    const ids = workspaceSessionIds(activeWorkspaceId);
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeSessionId as string);
    if (idx === -1) return;
    const next = direction === "prev"
      ? (idx - 1 + ids.length) % ids.length
      : (idx + 1) % ids.length;
    handleSelectSession(ids[next]);
  }, [workspaceSessionIds, activeWorkspaceId, activeSessionId, handleSelectSession]);

  // Ctrl+1..9 in the PC input bar jumps to the Nth session in the active workspace
  const switchToIndex = useCallback((i: number) => {
    const ids = workspaceSessionIds(activeWorkspaceId);
    if (i < 0 || i >= ids.length) return;
    handleSelectSession(ids[i]);
  }, [workspaceSessionIds, activeWorkspaceId, handleSelectSession]);

  // Named create (from the session list / sidebar / file tree). Keeps activeWorkspaceId
  // unchanged — the new session isn't in `sessions` yet (loadSessions is async) so
  // handleSelectSession would reset it. `cwd` overrides the inherited one (tree "new terminal here").
  // `agent` = {id,label,cmd,...} from the modal — the CLI is typed into the session on
  // first join. `yolo` adds the agent's own skip-permission flag/env to that command.
  const handleCreateSession = useCallback((
    name: string | null,
    workspaceId: string | null = null,
    shellId: string | null = null,
    cwd: string | null = null,
    agent: AgentConfig | null = null,
    yolo = false,
    nameIsAuto = false
  ) => {
    createSession(name, shellId, workspaceId, cwd || null, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      const startupCmd = agentLaunchCommand(agent, yolo);
      if (startupCmd) useTerminalStore.getState().queueStartup(result.sessionId, startupCmd);
      if (agent?.id) useTerminalStore.getState().setSessionAgent(result.sessionId, agent.id);
      const targetWs = workspaceId ?? null;
      setActiveWorkspaceId(targetWs);
      const wsIds = workspaceSessionIds(targetWs);
      wsIds.forEach((id) => addOpenedSession(id));
      addOpenedSession(result.sessionId);
      touchLivePane([...wsIds, result.sessionId]);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    }, nameIsAuto, agent);
  }, [createSession, workspaceSessionIds, addOpenedSession, touchLivePane, alertCreateFailed, currentView, replaceTopWithSession, pushView, setActiveWorkspaceId, requestFocus]);

  // Re-enter one past agent-CLI conversation: a fresh terminal parked in the
  // directory that conversation ran in, with the CLI's own resume line queued.
  const handleResumeAgentSession = useCallback((row: AgentHistoryRow) => {
    if (!row?.resume) return;
    // A conversation the host remembers as a chat takes the chat's own resume —
    // the id it was rebindable to on the host, not a CLI flag typed into a shell.
    const asUi = row.mode === "ui";
    // Resuming keeps the CLI's skip-permission mode: dropping back to per-action
    // approval is not where the conversation left off. The main host's CLI list
    // lives under its real head (see useAgentClis' slot normalization).
    const mainKey = useFleetStore.getState().currentKey || "main";
    const agentClisBy = useTerminalStore.getState().agentClisBy as Record<string, { list?: AgentConfig[] }>;
    const agent = agentClisBy[mainKey]?.list?.find((a) => a.id === row.agent) || null;
    const resumeLine = asUi ? null : applySkipPermissions(agent, row.resume);
    // Created unnamed on purpose: the agent names an auto-named terminal after
    // the conversation it runs, so the tab keeps following that chat's title.
    createSession(null, null, activeWorkspaceId, row.cwd || null, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      if (resumeLine) useTerminalStore.getState().queueStartup(result.sessionId, resumeLine);
      const agentId = asUi ? `${row.agent}-ui` : row.agent;
      if (agentId) useTerminalStore.getState().setSessionAgent(result.sessionId, agentId);
      // Tell the agent which conversation this terminal is resuming, so the
      // history row points at it before the CLI reports anything of its own.
      busRef?.current?.emit("claimAgentSession", {
        sessionId: result.sessionId, agent: agentId, conversationId: row.sessionId
      }, () => useTerminalStore.getState().invalidateAgentHistory());
      addOpenedSession(result.sessionId);
      touchLivePane(result.sessionId);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    });
  }, [createSession, activeWorkspaceId, addOpenedSession, touchLivePane, alertCreateFailed, replaceTopWithSession, pushView, currentView, requestFocus, busRef]);

  // Quick create in the active workspace (header "+" button, Mod+Shift+Enter chord).
  // Always focuses the new pane, unlike handleCreateSession which only does so from
  // terminal view. `agent`/`yolo`/`name` let the chord replay the modal's last choice.
  const handleQuickCreateSession = useCallback((shellId: string | null, agent: AgentConfig | null = null, yolo = false, name: string | null = null, nameIsAuto = false) => {
    createSession(name, shellId, activeWorkspaceId, null, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      const startupCmd = agentLaunchCommand(agent, yolo);
      if (startupCmd) useTerminalStore.getState().queueStartup(result.sessionId, startupCmd);
      if (agent?.id) useTerminalStore.getState().setSessionAgent(result.sessionId, agent.id);
      addOpenedSession(result.sessionId);
      touchLivePane(result.sessionId);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    }, nameIsAuto, agent);
  }, [createSession, activeWorkspaceId, addOpenedSession, touchLivePane, alertCreateFailed, replaceTopWithSession, pushView, currentView, requestFocus]);

  // The chat pane's "+": a fresh chat of the same engine, and the host closes the one it
  // replaced in the same transaction. The slot is handed over here rather than
  // added-then-removed — same pane count, so the row neither re-measures its widths nor
  // scrolls, and a create the host refuses leaves the chat on screen instead of losing both.
  const handleReplaceSession = useCallback((sessionId: string, name: string | null, agent: AgentConfig | null = null, nameIsAuto = false) => {
    // The replacement inherits the old terminal's dir — a chat rooted in a worktree must not jump back to the workspace root
    const oldCwd = sessions.find((s) => s.id === sessionId)?.cwd || null;
    createSession(name, null, activeWorkspaceId, oldCwd, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      const replaced = result.replaced || sessionId;
      if (agent?.id) useTerminalStore.getState().setSessionAgent(result.sessionId, agent.id);
      if (replaced) useTerminalStore.getState().replaceOpenedSession(replaced, result.sessionId);
      else addOpenedSession(result.sessionId);
      touchLivePane(result.sessionId);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    }, nameIsAuto, agent, sessionId);
  }, [createSession, activeWorkspaceId, alertCreateFailed, addOpenedSession, touchLivePane, replaceTopWithSession, pushView, currentView, requestFocus, sessions]);

  // Create from the FileExplorer bottom panel — stay in the current view
  const handleCreateSessionInline = useCallback((onCreated?: (sessionId: string) => void) => {
    createSession(null, (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      onCreated?.(result.sessionId);
    });
  }, [createSession, addOpenedSession, alertCreateFailed]);

  // Switch active workspace in terminal view — focus its first session
  const handleSelectWorkspace = useCallback((workspaceId: string | null) => {
    setActiveWorkspaceId(workspaceId);
    const inWorkspace = sessions.filter(s => sessionWorkspaceId(s) === (workspaceId ?? null));
    inWorkspace.forEach(s => addOpenedSession(s.id));
    touchLivePane(inWorkspace.map(s => s.id)); // keep this workspace's panes alive (LRU)
    const first = inWorkspace[0];
    if (first) replaceTopWithSession(first.id);
  }, [sessions, setActiveWorkspaceId, addOpenedSession, touchLivePane, replaceTopWithSession]);

  // Deleting closes the tab whatever machine owns it: a fleet session deletes over
  // its own bus (optimistic in the fleet store), a main one keeps the acked flow.
  // The after-delete focus handoff is shared by both branches.
  const handleDeleteSession = useCallback((sessionId: string) => {
    const deleted = sessions.find((s) => s.id === sessionId);
    const workspaceId = sessionWorkspaceId(deleted);
    const isDeletingActive = currentView?.type === "terminal" && currentView.sessionId === sessionId;
    const afterDelete = () => {
      removeOpenedSession(sessionId);
      useTerminalStore.getState().closeSession(sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      // Mobile has no shell left to hold the overlay once the last terminal is gone — back to the list, not a black screen
      if (!isDesktop && !remaining.length && OVERLAY_VIEWS.includes(currentView?.type ?? "")) {
        setViewStack([{ type: "list" }]);
        return;
      }
      if (!isDeletingActive) return;
      // Focus the next session (same workspace first, then any) or fall back to the list
      const sameWorkspace = remaining.filter((s) => sessionWorkspaceId(s) === workspaceId);
      const next = sameWorkspace[0] || remaining[0];
      if (next) {
        replaceTopWithSession(next.id);
        touchLivePane(next.id);
      } else {
        storePopView();
      }
    };
    const host = deleted?.hostKey ? useFleetStore.getState().hosts[deleted.hostKey] : null;
    if (host) {
      makeFleetActions(host).deleteSession(sessionId);
      afterDelete();
      return;
    }
    deleteSession(sessionId, afterDelete);
  }, [sessions, currentView, isDesktop, setViewStack, deleteSession, removeOpenedSession, touchLivePane, storePopView, replaceTopWithSession]);

  const handleRenameSession = useCallback((sessionId: string, newName: string) => {
    const hostKey = sessions.find((s) => s.id === sessionId)?.hostKey;
    if (hostKey) {
      const host = useFleetStore.getState().hosts[hostKey];
      if (host) makeFleetActions(host).renameSession(sessionId, newName);
      return;
    }
    renameSession(sessionId, newName, (result) => {
      if (!result.success) alert(t("workspace.failedRenameSession", { error: result.error }));
    });
  }, [sessions, renameSession, t]);

  // Passed down as a single `nav` prop — a fresh object per render would re-render every
  // memoized consumer even though all ten handlers are stable.
  return useMemo(() => ({
    handleSelectSession,
    handleSelectWorkspace,
    handleCreateSession,
    handleQuickCreateSession,
    handleReplaceSession,
    handleResumeAgentSession,
    handleCreateSessionInline,
    handleDeleteSession,
    handleRenameSession,
    switchSession,
    switchToIndex
  }), [handleSelectSession, handleSelectWorkspace, handleCreateSession, handleQuickCreateSession,
    handleReplaceSession, handleResumeAgentSession, handleCreateSessionInline, handleDeleteSession, handleRenameSession,
    switchSession, switchToIndex]);
}
