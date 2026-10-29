"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTreeCollapse, TREE_ROOT } from "@/features/hosts/lib/treeCollapse";
import {
  Check, Download, EyeOff, GripVertical, Image, Loader2, MoreHorizontal, Pencil, Plus, Trash2, X
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { IS_SELF_HOSTED } from "@/shared/constants/API";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { connOf } from "@/shared/transport/hostConn";
import { statusVisual } from "@/shared/utils/statusVisual";
import { useDragReorder } from "@/features/terminal/hooks/useDragReorder";
import { DRAG_HOLD_MS, DRAG_MOVE_TOLERANCE_PX } from "@/features/terminal/constants/terminalConfig";
import { workspaceGitPath } from "@/features/terminal/lib/workspaceGrouping";
import { ProfileAvatar } from "@/features/browser/lib/profileAvatar";
import { useBrowserStore } from "@/shared/stores/browserStore";

const NO_TABS: any[] = [];
import { useTerminalStore } from "@/shared/stores/terminalStore";
import WorkspaceHeader from "@/features/terminal/components/WorkspaceHeader";
import SessionAgentIcon from "@/features/terminal/components/SessionAgentIcon";
import SessionMeta from "@/features/terminal/components/SessionMeta";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import IconMenu from "@/shared/components/ui/IconMenu";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import FolderPickerModal from "@/features/terminal/components/FolderPickerModal";
import { addRecentWorkspace } from "@/features/fileExplorer/components/WorkspaceList";
import HostTreeRow from "./HostTreeRow";
import HostUpdateProgress from "./HostUpdateProgress";
import HostApprovalNotice from "./HostApprovalNotice";
import { hostTree, type FleetHost } from "../lib/fleetTree";
import type { FleetActions } from "../lib/fleetActions";

export interface HostTreeProps {
  host: FleetHost;
  actions?: Partial<FleetActions>;
  busRef?: React.MutableRefObject<any> | null;
  activeSessionId?: string | null;
  activeWorkspaceId?: string | null;
  connected?: boolean;
  fileBus?: any;
  homeDir?: string | null;
  hiddenPaneSessionIds?: string[];
  onUnhidePane?: ((sessionId: string) => void) | null;
  onAddWorkspace?: (() => void) | null;
  menuAddWorkspace?: (() => void) | null;
  onOpenRemoteHost?: ((key: string) => void) | null;
  onOpenMobileHost?: ((key: string) => void) | null;
  onRowContextMenu?: ((e: React.MouseEvent, sessionId: string, name: string) => void) | null;
  onRowTouch?: { start: (e: any) => void; move: (e: any) => void; end: (e: any) => void } | null;
  onRowMenu?: ((sessionId: string, name: string, rect: DOMRect) => void) | null;
  agentBySession?: Record<string, string> | null;
  cwdBySession?: Record<string, string> | null;
  treeCls?: string;
  mobile?: boolean;
  onResumeAgentSession?: ((session: any) => void) | null;
  rowCls?: string;
}

/**
 * ONE tree per host — the main host's and every other host's render through this.
 * The tree is host-agnostic: it draws `host` (label/status/workspaces/sessions/
 * statusMap, RAW ids) and acts through `actions` (the seam where main-host nav
 * and fleet-bus meets — see makeFleetActions). Whatever an action set leaves
 * null, its affordance simply does not render.
 */
export default function HostTree({
  host,
  actions = {},
  busRef = null,
  activeSessionId = null,
  activeWorkspaceId = null,
  connected = true,
  fileBus = null,
  homeDir = null,
  hiddenPaneSessionIds = [],
  onUnhidePane = null,
  onAddWorkspace = null,
  menuAddWorkspace = null,
  onOpenRemoteHost = null,
  onOpenMobileHost = null,
  onRowContextMenu = null,
  onRowTouch = null,
  onRowMenu = null,
  agentBySession = null,
  cwdBySession = null,
  treeCls = "pl-3.5",
  mobile = false,
  onResumeAgentSession = null,
  rowCls = "hover:bg-text/5 hover:text-text"
}: HostTreeProps) {
  const { t } = useI18n();
  const { isCollapsed, toggle: toggleNode } = useTreeCollapse(host.key);
  const open = !isCollapsed(TREE_ROOT);
  const [termModalWs, setTermModalWs] = useState<string | null>(null);
  const [wsRename, setWsRename] = useState<{ id: string; value: string } | null>(null);
  const [wsDelete, setWsDelete] = useState<{ id: string; name: string } | null>(null);
  const [sessRename, setSessRename] = useState<{ id: string; value: string } | null>(null);
  const [sessDelete, setSessDelete] = useState<{ id: string; name: string } | null>(null);
  const [wsPicker, setWsPicker] = useState(false);
  const [shells, setShells] = useState<any[]>([]);
  const [updateConfirm, setUpdateConfirm] = useState(false);

  const status = (host.status as string) || "full";
  const connecting = status === "connecting";
  const online = status === "full" || status === "online";
  const actionable = status === "full" ? connected : online;
  const expandable = online;
  const fleetConn = status !== "full" ? connOf(host.key) : null;
  const busTag = busRef || fleetConn?.busRef || null;

  // Shells for the new-terminal modal, fetched from THIS host's bus on demand.
  useEffect(() => {
    if (termModalWs === null || !busTag?.current?.emit) return;
    busTag.current.emit("getShells", (res: any) => setShells(res?.shells || []));
  }, [termModalWs, busTag]);

  const selectRow = (sessionId: string) => { vibrate(); actions.selectSession?.(sessionId); };
  const { dragId, registerEl, startDrag, consumeClick } = useDragReorder({
    axis: "y",
    onTap: selectRow,
    onCommit: (orderedIds: string[]) => actions.reorderSession?.(orderedIds)
  });

  const holdRef = useRef<{ timer: any; start: { x: number; y: number } } | null>(null);
  const clearHold = () => {
    if (holdRef.current) { clearTimeout(holdRef.current.timer); holdRef.current = null; }
  };
  const armHold = (e: React.PointerEvent, id: string, ids: string[]) => {
    if (ids.length < 2 || !actionable) return;
    if (e.pointerType === "mouse") { startDrag(e as any, id, ids); return; }
    if (onRowTouch) return;
    const start = { x: e.clientX, y: e.clientY };
    const down = e;
    const timer = setTimeout(() => { clearHold(); vibrate(); startDrag(down as any, id, ids); }, DRAG_HOLD_MS);
    holdRef.current = { timer, start };
  };
  const moveHold = (e: React.PointerEvent) => {
    const h = holdRef.current;
    if (!h) return;
    if (Math.abs(e.clientX - h.start.x) > DRAG_MOVE_TOLERANCE_PX || Math.abs(e.clientY - h.start.y) > DRAG_MOVE_TOLERANCE_PX) clearHold();
  };

  useEffect(() => {
    if (!dragId) return;
    const stopScroll = (e: TouchEvent) => e.preventDefault();
    window.addEventListener("touchmove", stopScroll, { passive: false });
    return () => window.removeEventListener("touchmove", stopScroll);
  }, [dragId]);

  const groups = hostTree(host.sessions, host.workspaces);
  const liveIds = useMemo(() => new Set((host.sessions || []).map((s) => s.id)), [host.sessions]);

  const createIn = (name: string | null, shellId: string | null, agent: any, yolo: boolean, cwd?: string | null, nameIsAuto?: boolean) => {
    actions.createSession?.(name, termModalWs === "ungrouped" ? null : termModalWs, shellId, cwd, agent, yolo, nameIsAuto);
    setTermModalWs(null);
  };

  return (
    <div>
      <HostTreeRow
        mobile={mobile}
        hostKey={host.key}
        label={host.label}
        connected={online}
        connecting={connecting}
        mutedOffline={status !== "full"}
        collapsed={!open}
        meta={connecting ? <Loader2 size={12} className="animate-spin text-text-subtle" /> : null}
        hostUpdating={!!host.updating}
        onOpenRemote={online && (host as any).remoteAvailable && onOpenRemoteHost ? () => onOpenRemoteHost(host.key) : null}
        onOpenMobile={online && (host as any).mobileAvailable && onOpenMobileHost && !host.updating ? () => onOpenMobileHost(host.key) : null}
        onToggleCollapse={expandable ? () => {
          vibrate();
          if (!open) useFleetStore.getState().ensureHost(host.key);
          toggleNode(TREE_ROOT);
        } : null}
        onConnect={status === "offline" ? ((host as any).onConnect || (() => useFleetStore.getState().connectHost(host.key))) : null}
        onDisconnect={(host as any).onDisconnect}
        onAddWorkspace={actionable ? (menuAddWorkspace ?? (status !== "full" ? () => setWsPicker(true) : null)) : null}
        onRename={actions.renameHost}
        onDelete={actions.deleteHost}
        showAdd={false}
      />

      {host.updating ? (
        <div className={`${treeCls} py-2`}>
          <HostUpdateProgress />
        </div>
      ) : (host as any).approval ? (
        <div className={treeCls}>
          <HostApprovalNotice hostKey={host.key} approval={(host as any).approval} onDeleteHost={actions.deleteHost} />
        </div>
      ) : open && expandable && (
        <div className={treeCls}>
          {!IS_SELF_HOSTED && (host as any).updateAvailable && (host as any).canSelfUpdate && !(host as any).approval && (
            <button
              type="button"
              onClick={() => { vibrate(); setUpdateConfirm(true); }}
              title={t("menu.updateAvailableTitle")}
              className="flex items-center gap-1.5 px-2 py-1 mb-1 max-w-full text-[11px] font-medium text-brand-400 hover:text-brand-300 bg-brand-500/10 hover:bg-brand-500/20 rounded-brand transition-colors"
            >
              <Download size={12} className="shrink-0" />
              <span className="truncate">
                {t("menu.updateNow")}{(host as any).updateAvailable?.version ? ` · ${(host as any).updateAvailable.version}` : ""}
              </span>
            </button>
          )}
          {groups.map(({ workspace, sessions }) => {
            const rawId = workspace?.id ?? null;
            const wsKey = rawId ?? "ungrouped";
            const isActiveWs = activeWorkspaceId === rawId;
            return (
              <div key={wsKey} className={`flex flex-col ${mobile ? "" : "mt-1 first:mt-0"}`}>
                <WorkspaceHeader
                  mobile={mobile}
                  workspace={{ id: rawId, name: (workspace as any)?.name || t("workspaces.ungrouped"), path: (workspace as any)?.path || null, items: sessions }}
                  isActive={isActiveWs}
                  connected={actionable}
                  fileBus={fileBus}
                  collapsed={isCollapsed(wsKey)}
                  onToggleCollapse={() => toggleNode(wsKey)}
                  onSelect={actions.selectWorkspace ? () => { vibrate(); actions.selectWorkspace!(rawId); } : undefined}
                  onNewTerminal={actions.createSession ? () => setTermModalWs(wsKey) : undefined}
                  onAddWorkspace={menuAddWorkspace as any}
                  onRename={actions.renameWorkspace && rawId != null ? () => setWsRename({ id: rawId, value: (workspace as any).name }) : undefined}
                  onDelete={actions.deleteWorkspace && rawId != null ? () => setWsDelete({ id: rawId, name: (workspace as any).name }) : undefined}
                />
                {!isCollapsed(wsKey) && sessions.map((s) => {
                  const st = (host as any).statusMap?.[s.id]?.state || "idle";
                  const v = statusVisual(st);
                  const isActive = activeSessionId === s.id;
                  const isDragging = dragId === s.id;
                  const hidden = hiddenPaneSessionIds.includes(s.id);
                  const title = (s as any).name || t("terminal.defaultName");
                  return (
                    <Fragment key={s.id}>
                    <div
                      ref={registerEl(s.id)}
                      data-sid={s.id}
                      className={`group flex items-center gap-1.5 ${mobile ? "pl-6 pr-9" : "pl-3.5 pr-2"} py-1.5 ml-0.5 rounded-[3px] text-left relative cursor-pointer select-none touch-manipulation touch-pan-y ${
                        isActive ? "bg-brand-500/15 text-text" : `text-text-muted ${rowCls}`
                      } ${isDragging ? "z-20 opacity-90 shadow-lg ring-1 ring-brand-500" : "transition-colors"}`}
                      onClick={() => { if (consumeClick()) return; selectRow(s.id); }}
                      onPointerDown={(e) => armHold(e, s.id, sessions.map((i) => i.id))}
                      onPointerMove={moveHold}
                      onPointerUp={clearHold}
                      onPointerCancel={clearHold}
                      onPointerLeave={clearHold}
                      onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, s.id, title) : undefined}
                      onTouchStart={onRowTouch?.start}
                      onTouchMove={onRowTouch?.move}
                      onTouchEnd={onRowTouch?.end}
                    >
                      {actionable && (
                        <button
                          data-gid={wsKey === "ungrouped" ? "" : rawId}
                          data-sid={s.id}
                          onPointerDown={(e) => { e.stopPropagation(); startDrag(e as any, s.id, sessions.map((i) => i.id)); }}
                          disabled={sessions.length < 2}
                          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-0.5 text-text-subtle opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing touch-none disabled:opacity-0 disabled:cursor-default"
                          tabIndex={-1}
                        >
                          <GripVertical size={12} />
                        </button>
                      )}
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                      <span className="flex-1 min-w-0 flex flex-col">
                        <span className={`flex items-center gap-1.5 min-w-0 ${isActive ? "font-medium" : ""}`}>
                          <SessionAgentIcon agent={agentBySession?.[s.id] ?? (s as any).agent} tool={(host as any).statusMap?.[s.id]?.tool} />
                          <span className={`${mobile ? "text-base" : "text-[11px]"} truncate`} data-tip={title}>{title}</span>
                          {hidden && onUnhidePane && (
                            <button
                              type="button"
                              tabIndex={-1}
                              onPointerDown={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); vibrate(); onUnhidePane(s.id); }}
                              className="p-0.5 rounded text-amber-400 hover:text-amber-300 hover:bg-amber-400/20 transition-colors flex items-center justify-center shrink-0 ml-1"
                              title={t("sessions.showPanel") || "Show panel"}
                            >
                              <EyeOff size={12} />
                            </button>
                          )}
                        </span>
                        <SessionMeta
                          mobile={mobile}
                          fileBus={fileBus}
                          cwd={cwdBySession?.[s.id] ?? (s as any).cwd ?? (s as any).workspacePath}
                          basePath={workspaceGitPath({ path: (workspace as any)?.path || null, items: sessions as any })}
                          homeDir={homeDir}
                        />
                      </span>
                      <div className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center ${mobile ? "opacity-100" : "px-1 rounded-[3px] bg-surface-2 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60"} transition-opacity`}>
                        {onRowMenu ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              vibrate();
                              const r = e.currentTarget.getBoundingClientRect();
                              onRowMenu(s.id, title, r);
                            }}
                            className="p-0.5 text-text-subtle hover:text-text rounded-[2px] transition-colors"
                            title={t("sessions.sessionActions")}
                          >
                            <MoreHorizontal size={mobile ? 18 : 13.5} />
                          </button>
                        ) : (
                          <IconMenu
                            size={mobile ? 18 : 13.5}
                            label={t("sessions.sessionActions")}
                            revealCls=""
                            items={([
                              st === "done" && {
                                icon: Check,
                                label: t("sessions.markRead"),
                                amber: true,
                                onClick: () => useNotificationStore.getState().clearNotification(s.id)
                              },
                              actions.renameSession && {
                                icon: Pencil,
                                label: t("sessions.editName"),
                                onClick: () => setSessRename({ id: s.id, value: (s as any).name || "" })
                              },
                              actions.backgroundSession && {
                                icon: Image,
                                label: t("menu.terminalBackground"),
                                onClick: () => actions.backgroundSession!(s)
                              },
                              actions.deleteSession && {
                                icon: Trash2,
                                label: t("sessions.deleteTitle"), danger: true,
                                onClick: () => setSessDelete({ id: s.id, name: (s as any).name || "" })
                              }
                            ].filter(Boolean)) as any}
                          />
                        )}
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
                {!isCollapsed(wsKey) && busRef && (
                  <BrowserTreeRow
                    busRef={busRef}
                    storeKey={rawId ?? "default"}
                    workspaceId={rawId}
                    mobile={mobile}
                    rowCls={rowCls}
                    onSelectWorkspace={actions.selectWorkspace ? () => actions.selectWorkspace!(rawId) : null}
                  />
                )}
                {!isCollapsed(wsKey) && (
                  mobile ? (
                    <button
                      onClick={() => { vibrate(); setTermModalWs(wsKey); }}
                      disabled={!actionable}
                      className="w-full flex items-center gap-1.5 pl-[38px] py-1.5 text-left text-sm text-text-subtle hover:text-brand-500 transition-colors disabled:opacity-40"
                      title={t("workspaces.addTerminal")}
                    >
                      <Plus size={14} className="flex-shrink-0" />
                      <span>{t("terminal.newTerminal")}</span>
                    </button>
                  ) : sessions.length === 0 ? (
                    <button
                      onClick={() => { vibrate(); setTermModalWs(wsKey); }}
                      disabled={!actionable}
                      className="w-full flex items-center gap-1.5 pl-3.5 pr-2 py-1.5 text-left text-[12px] text-text-subtle hover:text-brand-500 transition-colors disabled:opacity-40"
                      title={t("workspaces.addTerminal")}
                    >
                      <Plus size={12} className="flex-shrink-0" />
                      <span>{t("terminal.newTerminal")}</span>
                    </button>
                  ) : null
                )}
              </div>
            );
          })}

          <button
            onClick={() => { vibrate(); if (onAddWorkspace) onAddWorkspace(); else setWsPicker(true); }}
            disabled={!actionable}
            className={`w-full flex items-center gap-1.5 ${mobile ? "text-sm" : "text-[12px] mt-1"} py-1.5 text-left text-text-subtle hover:text-brand-500 transition-colors disabled:opacity-40`}
            title={t("workspaces.newWorkspace")}
          >
            <Plus size={mobile ? 18 : 12} className="flex-shrink-0" />
            <span>{t("workspaces.newWorkspace")}</span>
          </button>
        </div>
      )}

      {termModalWs !== null && (
        <NewTerminalModal
          onClose={() => setTermModalWs(null)}
          onCreate={createIn}
          shells={shells}
          busRef={busTag}
          hostKey={host.key}
          onResumeAgentSession={onResumeAgentSession}
          onSelectSession={actions.selectSession}
          liveSessionIds={liveIds}
          connected={actionable}
          workspaceId={termModalWs === "ungrouped" ? null : termModalWs}
          workspacePath={((host.workspaces?.find((w) => w.id === (termModalWs === "ungrouped" ? null : termModalWs)) as any)?.path as string | null) || null}
          workspaceName={termModalWs === "ungrouped" ? t("workspaces.ungrouped") : host.workspaces?.find((w) => w.id === termModalWs)?.name || ""}
          suggestName={`${t("terminal.defaultName")} ${(host.sessions?.length || 0) + 1}`}
        />
      )}

      {wsPicker && fleetConn && (
        <FolderPickerModal
          fileBus={fleetConn.fileBus}
          initialPath={null}
          scope={fleetConn.scope}
          onSelect={(folderPath: string | null) => {
            setWsPicker(false);
            if (!folderPath) return;
            const name = folderPath.split("/").filter(Boolean).pop() || folderPath;
            addRecentWorkspace(folderPath, fleetConn.scope);
            actions.createWorkspace?.(name, folderPath, (result: any) => {
              const ws = result?.workspace || result?.group;
              if (!result?.success || !ws?.id) return;
              actions.createSession?.(null, ws.id, null, folderPath);
            });
          }}
          onClose={() => setWsPicker(false)}
        />
      )}

      {wsRename !== null && (
        <PromptDialog
          title={t("workspaces.rename")}
          value={wsRename.value}
          onChange={(value) => setWsRename({ ...wsRename, value })}
          onSubmit={() => {
            const name = wsRename.value.trim();
            if (name) actions.renameWorkspace?.(wsRename.id, name);
            setWsRename(null);
          }}
          onClose={() => setWsRename(null)}
        />
      )}

      {wsDelete !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => setWsDelete(null)}
          onConfirm={() => { actions.deleteWorkspace?.(wsDelete.id); setWsDelete(null); }}
          title={t("workspaces.deleteTitle")}
          message={t("workspaces.deleteMessage", { name: wsDelete.name })}
          confirmText={t("common.delete")}
        />
      )}

      <ConfirmDialog
        isOpen={updateConfirm}
        onClose={() => setUpdateConfirm(false)}
        onConfirm={() => { setUpdateConfirm(false); useFleetStore.getState().requestHostUpdate(host.key, "update"); }}
        title={t("menu.updateConfirmTitle")}
        message={t("menu.updateConfirmMessage")}
      />

      {sessRename !== null && (
        <PromptDialog
          title={t("sessions.editName")}
          value={sessRename.value}
          onChange={(value) => setSessRename({ ...sessRename, value })}
          onSubmit={() => {
            const name = sessRename.value.trim();
            if (name) actions.renameSession?.(sessRename.id, name);
            setSessRename(null);
          }}
          onClose={() => setSessRename(null)}
        />
      )}

      {sessDelete !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => setSessDelete(null)}
          onConfirm={() => { actions.deleteSession?.(sessDelete.id); setSessDelete(null); }}
          title={t("sessions.deleteTitle")}
          message={t("sessions.deleteMessage", { name: sessDelete.name || "" })}
          confirmText={t("common.delete")}
        />
      )}
    </div>
  );
}

interface BrowserTreeRowProps {
  busRef?: any;
  storeKey: string;
  workspaceId: string | null;
  mobile?: boolean;
  rowCls?: string;
  onSelectWorkspace?: (() => void) | null;
}

// The workspace's browser TABS as pseudo-session rows: same row shape as a
// terminal session — profile-colored dot, profile avatar, session-font title.
function BrowserTreeRow({ busRef, storeKey, workspaceId, mobile, rowCls, onSelectWorkspace }: BrowserTreeRowProps) {
  const profile = useBrowserStore((s) => s.workspaceProfiles[storeKey] || "default");
  const tabs = useBrowserStore((s) => s.tabsByWorkspace[storeKey] ?? NO_TABS);
  const activeTabId = useBrowserStore((s) => s.activeByWorkspace[storeKey] || null);
  const isBrowserView = useTerminalStore((s) => {
    const stack = s.viewStack;
    return Boolean(stack && stack[stack.length - 1]?.type === "browser");
  });
  const pushView = useTerminalStore((s) => s.pushView);
  // Judge "active" from the live pick: the mobile list passes HostTree no active id.
  const activeWs = useTerminalStore((s) => (s.activeWorkspaceId ?? null) === workspaceId);
  const setActiveWorkspaceId = useTerminalStore((s) => s.setActiveWorkspaceId);
  if (!tabs.length) return null;
  const open = (targetId: string) => {
    vibrate();
    if (!activeWs) {
      // No selection door (mobile list): aim the pane at this workspace directly.
      if (onSelectWorkspace) onSelectWorkspace();
      else setActiveWorkspaceId(workspaceId);
    }
    useBrowserStore.getState().setActive(storeKey, targetId);
    pushView({ type: "browser" });
  };
  return tabs.map((tab: any) => {
    const isActive = isBrowserView && activeWs && tab.id === activeTabId;
    const title = tab.title || "Browser";
    return (
      <div
        key={tab.id}
        className={`group flex items-center gap-1.5 ${mobile ? "pl-6" : "pl-3.5"} pr-2 py-1.5 ml-0.5 rounded-[3px] text-left relative cursor-pointer select-none touch-manipulation touch-pan-y transition-colors ${
          isActive ? "bg-brand-500/15 text-text" : `text-text-muted ${rowCls}`
        }`}
        onClick={() => open(tab.id)}
        title={tab.url}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0 bg-white shadow-[0_0_4px_rgba(255,255,255,0.8)]" />
        <ProfileAvatar name={profile} size={14} />
        <span className={`flex-1 min-w-0 truncate ${mobile ? "text-base" : "text-[11px]"} ${isActive ? "font-medium" : ""}`} data-tip={title}>{title}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            vibrate();
            busRef?.current?.emit?.("browser:invoke", {
              action: "close",
              payload: { targetId: tab.id, profile: useBrowserStore.getState().workspaceProfiles[storeKey] || "default" }
            }, () => {});
            const st = useBrowserStore.getState();
            const next = (st.tabsByWorkspace[storeKey] || []).filter((t2: any) => t2.id !== tab.id);
            st.setTabs(storeKey, next);
            if (st.activeByWorkspace[storeKey] === tab.id) st.setActive(storeKey, next[0]?.id || null);
          }}
          className={`p-0.5 rounded text-text-muted hover:text-text hover:bg-surface-3 shrink-0 ${mobile ? "flex" : "opacity-0 group-hover:opacity-100"} transition-opacity`}
          title="Close tab"
        >
          <X size={12} />
        </button>
      </div>
    );
  });
}
