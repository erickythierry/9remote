"use client";

import { useEffect, useState, useMemo } from "react";
import { X, History, Trash2, Search, GitFork, ListChecks } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import ConfirmDialog from "./ConfirmDialog";

function relativeAge(ms: number, t: any) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return t("agentHistory.minutesAgo", { n: Math.max(1, mins) });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("agentHistory.hoursAgo", { n: hours });
  return t("agentHistory.daysAgo", { n: Math.round(hours / 24) });
}

function formatBytes(bytes: any) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

// Split a snippet on the query that fetched it; matched spans render as <mark>
// (weight + tint, never color alone). q is the SENT query, not the draft.
function highlightQuery(text: string, q?: string) {
  if (!q) return text;
  const parts = String(text).split(new RegExp(`(${q.replace(ESCAPE_RE, "\\$&")})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase()
      ? <mark key={i} className="bg-transparent text-text font-semibold px-0">{part}</mark>
      : part
  );
}

export default function AgentHistoryModal({
  isOpen,
  onClose,
  busRef,
  cwd,
  scope = "",
  onResume,
  onSelectSession,
  liveSessionIds,
  activeSessionId,
  connected = true
}: any) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [deletingSession, setDeletingSession] = useState<any>(null);
  const [globalRows, setGlobalRows] = useState<any[]>([]);
  const [activeQuery, setActiveQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);

  // Multi-selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Same path on two machines is two histories — key through the host scope.
  const historyKey = scope ? `${scope}|${cwd}` : cwd;

  const rawSessions = useTerminalStore((s) => (cwd ? s.agentHistory[historyKey]?.sessions : null));
  const sessions = useMemo(() => rawSessions || [], [rawSessions]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedKeys(new Set());
      setSelectMode(false);
      setConfirmBulkDelete(false);
      setDeletingSession(null);
      setLastSelectedIndex(null);
    }
  }, [isOpen]);

  useEffect(() => {
    setLastSelectedIndex(null);
  }, [query, selectedAgent]);

  // 3+ chars widens the box's local filter into a host-wide content search
  // across every directory's transcripts; rows land in the same list below.
  // Inactive states are derived at render — the effect only sets state async.
  const searchActive = isOpen && connected && query.trim().length >= 3;
  useEffect(() => {
    if (!searchActive) return;
    const q = query.trim();
    let stale = false;
    const timer = setTimeout(() => {
      setSearching(true);
      busRef?.current?.emit("searchAgentSessions", { query: q }, (res: any) => {
        if (stale) return;
        setSearching(false);
        setSearchTruncated(!!res?.truncated);
        setGlobalRows(Array.isArray(res?.sessions) ? res.sessions : []);
        // Snippets/highlights answer the query that produced them, not the draft.
        setActiveQuery(q);
      });
    }, 350);
    return () => { stale = true; clearTimeout(timer); };
  }, [query, searchActive, busRef]);

  useEffect(() => {
    if (!isOpen) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deletingSession && !confirmBulkDelete) {
        if (selectedKeys.size > 0 || selectMode) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedKeys(new Set());
          setSelectMode(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, deletingSession, confirmBulkDelete, selectedKeys.size, selectMode]);

  const agentTypes = useMemo(() => {
    const set = new Set();
    for (const s of sessions) {
      if ((s as any).agent) set.add((s as any).agent);
    }
    return Array.from(set);
  }, [sessions]);

  const rowMatches = (s: any, q: string) => {
    const title = (s.title || "").toLowerCase();
    const id = (s.sessionId || "").toLowerCase();
    const agent = (s.agent || "").toLowerCase();
    return title.includes(q) || id.includes(q) || agent.includes(q);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: any[] = [];
    const seen = new Set();
    // Content hits for conversations already in this list — attach the snippet
    // so a title-matching local row still shows WHY it matched.
    const snippetByKey = new Map();
    for (const s of (searchActive ? globalRows : [])) {
      if (s.snippet) snippetByKey.set(`${s.agent}:${s.sessionId}`, s.snippet);
    }
    for (const s of sessions) {
      if (selectedAgent !== "all" && (s as any).agent !== selectedAgent) continue;
      if (!q || rowMatches(s, q)) {
        const snippet = snippetByKey.get(`${(s as any).agent}:${(s as any).sessionId}`);
        out.push(snippet ? { ...s, snippet } : s);
        seen.add(`${(s as any).agent}:${(s as any).sessionId}`);
      }
    }
    for (const s of (searchActive ? globalRows : [])) {
      if (seen.has(`${s.agent}:${s.sessionId}`)) continue;
      if (selectedAgent !== "all" && s.agent !== selectedAgent) continue;
      // Foreign marks a search hit from outside this list's store — its delete
      // would miss. Local rows (worktree branch rows included) stay deletable.
      out.push({ ...s, foreign: true });
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [sessions, globalRows, searchActive, query, selectedAgent]);

  const deletableFiltered = useMemo(() => {
    return filtered.filter((row) => {
      const openId = row.openSessionId && liveSessionIds?.has(row.openSessionId) ? row.openSessionId : null;
      return !openId && !row.foreign;
    });
  }, [filtered, liveSessionIds]);

  const isAllSelected = deletableFiltered.length > 0 && deletableFiltered.every((r) => selectedKeys.has(`${r.agent}:${r.sessionId}`));
  const isIndeterminate = !isAllSelected && deletableFiltered.some((r) => selectedKeys.has(`${r.agent}:${r.sessionId}`));

  const handleToggleSelectAll = () => {
    vibrate();
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (isAllSelected) {
        for (const r of deletableFiltered) {
          next.delete(`${r.agent}:${r.sessionId}`);
        }
      } else {
        for (const r of deletableFiltered) {
          next.add(`${r.agent}:${r.sessionId}`);
        }
      }
      return next;
    });
  };

  const handleRowSelect = (rowKey: any, index: any, isShift = false) => {
    vibrate();
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (isShift && lastSelectedIndex !== null && lastSelectedIndex !== index) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        for (let i = start; i <= end; i++) {
          const r = filtered[i];
          if (!r) continue;
          const openId = r.openSessionId && liveSessionIds?.has(r.openSessionId) ? r.openSessionId : null;
          if (!openId && !r.foreign) {
            next.add(`${r.agent}:${r.sessionId}`);
          }
        }
      } else {
        if (next.has(rowKey)) {
          next.delete(rowKey);
        } else {
          next.add(rowKey);
        }
      }
      return next;
    });
    setLastSelectedIndex(index);
    if (!selectMode) {
      setSelectMode(true);
    }
  };

  if (!isOpen) return null;

  const handleResume = (row: any, openId?: any) => {
    vibrate();
    if (openId) onSelectSession?.(openId);
    else onResume?.(row);
    onClose();
  };

  const handleConfirmDelete = () => {
    if (!deletingSession) return;
    const { agent, sessionId } = deletingSession;
    vibrate();

    const rowKey = `${agent}:${sessionId}`;

    // Optimistically remove from store
    const nextSessions = sessions.filter((s: any) => !(s.agent === agent && s.sessionId === sessionId));
    useTerminalStore.getState().setAgentHistory(historyKey, nextSessions);
    setGlobalRows((prev) => prev.filter((s) => !(s.agent === agent && s.sessionId === sessionId)));
    setSelectedKeys((prev) => {
      if (prev.has(rowKey)) {
        const next = new Set(prev);
        next.delete(rowKey);
        return next;
      }
      return prev;
    });

    busRef?.current?.emit("deleteAgentSession", { agent, sessionId, cwd: deletingSession.cwd || cwd }, (res: any) => {
      if (!res?.success) {
        // Re-fetch on error
        busRef?.current?.emit("getAgentSessions", { cwd }, (r: any) => {
          if (Array.isArray(r?.sessions)) useTerminalStore.getState().setAgentHistory(historyKey, r.sessions);
        });
      }
    });

    setDeletingSession(null);
  };

  const handleConfirmBulkDelete = () => {
    if (selectedKeys.size === 0) return;
    vibrate();
    setIsBulkDeleting(true);

    const toDeleteRows = sessions.filter((s: any) => selectedKeys.has(`${s.agent}:${s.sessionId}`));
    const keysToDelete = new Set(selectedKeys);

    // Optimistically remove from store
    const nextSessions = sessions.filter((s: any) => !keysToDelete.has(`${s.agent}:${s.sessionId}`));
    useTerminalStore.getState().setAgentHistory(historyKey, nextSessions);
    setGlobalRows((prev) => prev.filter((s) => !keysToDelete.has(`${s.agent}:${s.sessionId}`)));

    // Emit deleteAgentSession for each selected session with timeout guard
    const deletePromises = toDeleteRows.map(
      (s: any) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ success: false, timeout: true }), 8000);
          busRef?.current?.emit("deleteAgentSession", { agent: s.agent, sessionId: s.sessionId, cwd: s.cwd || cwd }, (res: any) => {
            clearTimeout(timer);
            resolve(res);
          });
        })
    );

    Promise.all(deletePromises)
      .then((results: any[]) => {
        const anyFailed = results.some((r) => !(r as any)?.success);
        if (anyFailed) {
          busRef?.current?.emit("getAgentSessions", { cwd }, (r: any) => {
            if (Array.isArray(r?.sessions)) {
              useTerminalStore.getState().setAgentHistory(historyKey, r.sessions);
            }
          });
        }
      })
      .finally(() => {
        setIsBulkDeleting(false);
      });

    setSelectedKeys(new Set());
    setSelectMode(false);
    setConfirmBulkDelete(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200 touch-none"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-xl w-full max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-200 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <History size={17} className="text-text-muted" />
            <h3 className="text-base font-semibold text-text">{t("agentHistory.title")}</h3>
            <span className="px-2 py-0.5 text-xs rounded-full bg-surface-2 text-text-subtle font-mono">
              {sessions.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {sessions.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  if (selectMode || selectedKeys.size > 0) {
                    setSelectedKeys(new Set());
                    setSelectMode(false);
                  } else {
                    setSelectMode(true);
                  }
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded-brand transition-colors flex items-center gap-1.5 ${
                  selectMode || selectedKeys.size > 0
                    ? "bg-brand-500/15 text-brand-500 border border-brand-500/30"
                    : "text-text-muted hover:text-text hover:bg-surface-2 border border-transparent"
                }`}
                title={selectMode || selectedKeys.size > 0 ? t("agentHistory.cancel") : t("agentHistory.selectMultiple")}
              >
                <ListChecks size={14} />
                <span>{selectMode || selectedKeys.size > 0 ? t("agentHistory.cancel") : t("agentHistory.select")}</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
              aria-label={t("common.close")}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="p-3 border-b border-border-subtle flex flex-col gap-2.5 bg-surface-2/30 flex-shrink-0">
          <div className="relative flex items-center">
            <Search size={15} className="absolute left-3 text-text-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("agentHistory.searchPlaceholder")}
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-surface-2 border border-border-subtle rounded-brand text-text placeholder-text-muted outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/20 transition-all"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2.5 p-0.5 text-text-muted hover:text-text rounded transition-colors"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Fixed-height slot: the searching/truncated line comes and goes
              without ever pushing the list up or down. */}
          <div className="h-4 px-1 text-[11px] leading-4 text-text-subtle">
            {searchActive && (searching
              ? t("agentHistory.searchingAll")
              : searchTruncated ? t("agentHistory.searchTruncated") : null)}
          </div>

          {agentTypes.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              <button
                onClick={() => setSelectedAgent("all")}
                className={`shrink-0 h-7 px-3.5 text-xs rounded-brand transition-colors whitespace-nowrap flex items-center justify-center ${
                  selectedAgent === "all"
                    ? "bg-surface-3 text-text font-medium border border-border-subtle shadow-sm"
                    : "bg-surface-2/60 text-text-muted hover:text-text hover:bg-surface-2 border border-transparent"
                }`}
              >
                {t("agentHistory.allAgents")}
              </button>
              {agentTypes.map((ag: any) => (
                <button
                  key={String(ag)}
                  onClick={() => setSelectedAgent(String(ag))}
                  className={`shrink-0 h-7 px-3.5 text-xs rounded-brand transition-colors flex items-center gap-2 whitespace-nowrap capitalize ${
                    selectedAgent === String(ag)
                      ? "bg-surface-3 text-text font-medium border border-border-subtle shadow-sm"
                      : "bg-surface-2/60 text-text-muted hover:text-text hover:bg-surface-2 border border-transparent"
                  }`}
                >
                  <img src={agentIconUrl(String(ag)) || ""} alt="" className={`w-3.5 h-3.5 ${AGENT_ICON_CLS}`} />
                  <span>{String(ag)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Bulk action toolbar */}
        {(selectMode || selectedKeys.size > 0) && (
          <div className="px-4 py-2 bg-surface-2 border-b border-border-subtle flex items-center justify-between text-xs flex-shrink-0 animate-in fade-in duration-150">
            <div className="flex items-center gap-2.5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = isIndeterminate;
                  }}
                  onChange={handleToggleSelectAll}
                  disabled={deletableFiltered.length === 0}
                  className="w-4 h-4 accent-brand-500 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                />
                <span className="text-text font-medium text-xs">
                  {isAllSelected ? t("agentHistory.deselectAll") : t("agentHistory.selectAll")}
                </span>
              </label>
              <span className="text-text-muted font-mono text-[11px]">
                ({selectedKeys.size} {t("agentHistory.selected")})
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  vibrate();
                  setSelectedKeys(new Set());
                  setSelectMode(false);
                }}
                className="px-2.5 py-1 text-xs text-text-muted hover:text-text hover:bg-surface-3 rounded-brand transition-colors"
              >
                {t("agentHistory.cancel")}
              </button>
              <button
                type="button"
                disabled={selectedKeys.size === 0 || !connected || isBulkDeleting}
                onClick={() => {
                  vibrate();
                  setConfirmBulkDelete(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-surface-3 text-white disabled:text-text-muted/50 rounded-brand disabled:cursor-not-allowed transition-all font-medium text-xs active:scale-95 shadow-sm"
              >
                <Trash2 size={13} />
                <span>
                  {t("agentHistory.deleteSelected")}
                  {selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ""}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Sessions list — fixed height so result count never resizes the modal
            while typing; results swap inside the scroll area instead. */}
        <div className="h-[55vh] min-h-0 overflow-y-auto modal-scrollable p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-text-muted text-sm gap-2">
              <History size={32} className="opacity-40" />
              <span>{query ? t("agentHistory.noResults") : t("agentHistory.empty")}</span>
            </div>
          ) : (
            filtered.map((row, index) => {
              const rowKey = `${row.agent}:${row.sessionId}`;
              const openId = row.openSessionId && liveSessionIds?.has(row.openSessionId)
                ? row.openSessionId
                : null;
              const title = row.title || t("agentHistory.untitled");
              // Search hit from outside this list's store: no delete, show its path.
              const foreign = !!row.foreign;
              const canDelete = !openId && !foreign;
              const isSelected = selectedKeys.has(rowKey);

              return (
                <div
                  key={rowKey}
                  onClick={(e) => {
                    if (selectMode || selectedKeys.size > 0) {
                      if (canDelete) handleRowSelect(rowKey, index, e.shiftKey);
                    } else {
                      handleResume(row, openId);
                    }
                  }}
                  className={`group flex items-center gap-2.5 px-3 py-2 rounded-brand cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-brand-500/15 border border-brand-500/30 text-text"
                      : "hover:bg-surface-2 border border-transparent"
                  }`}
                >
                  {/* Checkbox column — fixed width prevents any layout shifts on hover */}
                  <div
                    className={`w-4 h-4 flex items-center justify-center flex-shrink-0 transition-opacity ${
                      canDelete
                        ? selectMode || selectedKeys.size > 0 || isSelected
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100"
                        : selectMode || selectedKeys.size > 0
                        ? "opacity-20 pointer-events-none"
                        : "opacity-0 pointer-events-none"
                    }`}
                    onClick={(e) => {
                      if (!canDelete) return;
                      e.stopPropagation();
                      handleRowSelect(rowKey, index, e.shiftKey);
                    }}
                  >
                    {canDelete ? (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        tabIndex={-1}
                        className="w-4 h-4 accent-brand-500 rounded cursor-pointer pointer-events-none"
                      />
                    ) : (
                      <span className="w-3.5 h-3.5 rounded border border-border-subtle inline-block" />
                    )}
                  </div>

                  <img
                    src={agentIconUrl(row.agent) || ""}
                    alt={row.agent}
                    className={`w-5 h-5 flex-shrink-0 object-contain ${AGENT_ICON_CLS} ${openId ? "" : "opacity-70"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs truncate ${openId || isSelected ? "text-text font-medium" : "text-text-muted"}`}>
                        {title}
                      </span>
                      {openId && (
                        <span className="px-2 py-0.5 text-[10px] leading-none rounded bg-success/15 text-success border border-success/25 flex-shrink-0 font-medium">
                          {t("agentHistory.openNow")}
                        </span>
                      )}
                    </div>
                    {row.snippet && (
                      <div className="mt-0.5 text-[11px] leading-snug text-text-subtle line-clamp-2">
                        {highlightQuery(row.snippet, activeQuery)}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-text-subtle min-w-0">
                      {foreign && row.cwd && row.cwd !== cwd && (
                        <>
                          <span className="truncate min-w-0 max-w-[45%] font-mono" title={row.cwd}>
                            {row.cwd}
                          </span>
                          <span>•</span>
                        </>
                      )}
                      {/* Worktree rows name their branch here; main-checkout rows stay bare */}
                      {row.branch && row.branch !== "main" && row.branch !== "master" && (
                        <>
                          <span className="flex items-center gap-0.5 min-w-0 max-w-[45%]" title={row.branch}>
                            <GitFork size={9} className="text-brand-500 shrink-0" />
                            <span className="truncate">{row.branch}</span>
                          </span>
                          <span>•</span>
                        </>
                      )}
                      <span className="capitalize">{row.agent}</span>
                      <span>•</span>
                      <span className="tabular-nums">{relativeAge(row.updatedAt, t)}</span>
                      {row.size > 0 && (
                        <>
                          <span>•</span>
                          <span className="tabular-nums font-mono text-[10px] opacity-75">{formatBytes(row.size)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!selectMode && selectedKeys.size === 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingSession(row);
                        }}
                        disabled={!connected || !!openId || !!foreign}
                        className={`p-1.5 text-text-muted hover:text-danger hover:bg-danger/10 rounded-brand transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 ${
                          openId || foreign ? "invisible pointer-events-none" : ""
                        }`}
                        title={t("agentHistory.delete")}
                        aria-label={t("agentHistory.delete")}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {deletingSession && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => setDeletingSession(null)}
          onConfirm={handleConfirmDelete}
          title={t("agentHistory.deleteTitle")}
          message={t("agentHistory.deleteMessage", { title: deletingSession?.title || t("agentHistory.untitled") })}
        />
      )}

      {confirmBulkDelete && (() => {
        const singleRow = selectedKeys.size === 1 ? sessions.find((s) => selectedKeys.has(`${s.agent}:${s.sessionId}`)) : null;
        return (
          <ConfirmDialog
            isOpen={true}
            onClose={() => setConfirmBulkDelete(false)}
            onConfirm={handleConfirmBulkDelete}
            title={selectedKeys.size === 1 ? t("agentHistory.deleteTitle") : t("agentHistory.deleteMultipleTitle", { n: selectedKeys.size })}
            message={
              selectedKeys.size === 1
                ? t("agentHistory.deleteMessage", { title: singleRow?.title || t("agentHistory.untitled") })
                : t("agentHistory.deleteMultipleMessage", { n: selectedKeys.size })
            }
          />
        );
      })()}
    </div>
  );
}
