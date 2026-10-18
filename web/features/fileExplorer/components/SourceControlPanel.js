"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  GitBranch,
  RefreshCw,
  MoreHorizontal,
  GitFork,
  ExternalLink,
  Copy,
  Terminal,
  Loader2
} from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { GIT_REFRESH_EVENT } from "../constants/fileExplorer.js";
import { useWorkspaceRepos } from "@/features/terminal/hooks/useWorkspaceRepos";
import { useWorkspaceChangedCount } from "@/features/terminal/hooks/useWorkspaceChangedCount";
import ScmPanel from "./ScmPanel.js";

// VSCode Octicon repository icons
function RepoCodicon({ isSubmodule = false, isSelected = false }) {
  if (isSubmodule) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`shrink-0 ${isSelected ? "text-text" : "text-text-muted"}`}
      >
        <path
          d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5v-9zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8V1.5z"
          opacity="0.6"
        />
        <circle cx="5" cy="5.5" r="1.5" />
        <circle cx="10" cy="10.5" r="1.5" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={`shrink-0 ${isSelected ? "text-text" : "text-text-muted"}`}
    >
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5v-9zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8V1.5z" />
    </svg>
  );
}

// Build hierarchical repo tree: repos whose paths sit inside another repo are nested under it.
function buildRepoTree(repos, workspace) {
  if (!repos || !repos.length) return [];
  const sorted = [...repos].sort((a, b) => a.path.localeCompare(b.path));
  const nodes = sorted.map((r) => ({
    ...r,
    children: [],
    parentId: null
  }));

  const roots = [];

  for (const node of nodes) {
    let parent = null;
    for (const candidate of nodes) {
      if (candidate.path !== node.path && node.path.startsWith(`${candidate.path}/`)) {
        if (!parent || candidate.path.length > parent.path.length) {
          parent = candidate;
        }
      }
    }
    if (parent) {
      node.parentId = parent.path;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export default function SourceControlPanel({
  workspace,
  fileBus,
  onOpenFile,
  onActiveRepoChange
}) {
  const { t } = useI18n();

  const { repos, refresh: refreshRepos, scanning, deep, scanDeeper } = useWorkspaceRepos(workspace, fileBus);
  const { perRepo: livePerRepo } = useWorkspaceChangedCount(workspace, fileBus);

  // Sections collapse state
  const [reposExpanded, setReposExpanded] = useState(true);
  const [changesExpanded, setChangesExpanded] = useState(true);

  // Selected repository for the "Changes" / ScmPanel below
  const [selectedRepoPath, setSelectedRepoPath] = useState(null);

  // Expanded nodes inside the Repositórios tree
  const [expandedNodes, setExpandedNodes] = useState(() => new Set());
  const initializedExpandedRef = useRef(false);

  // Context menu for a repo in the list
  const [repoMenu, setRepoMenu] = useState(null);
  const [headerMenu, setHeaderMenu] = useState(null);
  const [syncingRepo, setSyncingRepo] = useState(null);

  const countOf = useCallback((repo) => {
    return livePerRepo[repo.path] ?? repo.changedCount ?? 0;
  }, [livePerRepo]);

  // Build tree
  const repoTree = useMemo(() => buildRepoTree(repos, workspace), [repos, workspace]);

  // Expand parent nodes by default when repos arrive
  useEffect(() => {
    if (!initializedExpandedRef.current && repos.length > 0) {
      initializedExpandedRef.current = true;
      const parents = new Set();
      for (const r of repos) {
        if (repos.some((other) => other.path !== r.path && other.path.startsWith(`${r.path}/`))) {
          parents.add(r.path);
        }
      }
      setExpandedNodes(parents);
    }
  }, [repos]);

  // Active repo path: selected or first repo in list or workspace
  const activeRepoPath = useMemo(() => {
    if (selectedRepoPath && repos.some((r) => r.path === selectedRepoPath)) {
      return selectedRepoPath;
    }
    if (repos.length > 0) {
      const mainRepo = repos.find((r) => r.path === workspace || !r.relPath);
      return mainRepo?.path || repos[0].path;
    }
    return workspace;
  }, [selectedRepoPath, repos, workspace]);

  // Notify parent if active repo changes
  useEffect(() => {
    onActiveRepoChange?.(activeRepoPath);
  }, [activeRepoPath, onActiveRepoChange]);

  const toggleNode = useCallback((repoPath) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(repoPath)) next.delete(repoPath);
      else next.add(repoPath);
      return next;
    });
  }, []);

  const handleSelectRepo = useCallback((repo) => {
    vibrate(10);
    setSelectedRepoPath(repo.path);
  }, []);

  const handleRefreshAll = useCallback(() => {
    vibrate(10);
    refreshRepos();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT));
    }
  }, [refreshRepos]);

  const handleSyncRepo = useCallback(async (repo) => {
    if (!fileBus || syncingRepo) return;
    vibrate(10);
    setSyncingRepo(repo.path);
    try {
      await fileBus.gitPull?.(repo.path);
      refreshRepos();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT));
      }
    } catch {
      // Ignore network errors on background sync
    } finally {
      setSyncingRepo(null);
    }
  }, [fileBus, syncingRepo, refreshRepos]);

  const openRepoMenu = useCallback((repo, e) => {
    e.preventDefault();
    e.stopPropagation();
    vibrate(10);
    const rect = e.currentTarget.getBoundingClientRect();
    setRepoMenu({
      repo,
      x: Math.min(rect.right, window.innerWidth - 180),
      y: rect.bottom + 4
    });
  }, []);

  // Close menus on outside click or scroll
  useEffect(() => {
    if (!repoMenu && !headerMenu) return;
    const close = () => {
      setRepoMenu(null);
      setHeaderMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [repoMenu, headerMenu]);

  // Render a repo item in the tree
  const renderRepoItem = (repo, level = 0) => {
    const isSelected = activeRepoPath === repo.path;
    const hasChildren = repo.children && repo.children.length > 0;
    const isExpanded = expandedNodes.has(repo.path);
    const count = countOf(repo);
    const displayName = repo.parentId ? (repo.relPath?.split("/").pop() || repo.name) : (repo.relPath || repo.name);

    return (
      <div key={repo.path} className="flex flex-col">
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleSelectRepo(repo)}
          onContextMenu={(e) => openRepoMenu(repo, e)}
          style={{ paddingLeft: `${8 + level * 14}px` }}
          className={`group/repo relative flex items-center gap-1.5 pr-2 py-1 cursor-pointer select-none border-b border-border-subtle/40 transition-colors ${
            isSelected
              ? "bg-surface-2 text-text font-medium"
              : "text-text-muted hover:text-text hover:bg-surface-2/60"
          }`}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                vibrate(10);
                toggleNode(repo.path);
              }}
              className="w-3.5 h-3.5 flex items-center justify-center text-text-muted hover:text-text shrink-0"
            >
              <ChevronRight
                size={11}
                className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
              />
            </button>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          <RepoCodicon isSubmodule={level > 0} isSelected={isSelected} />

          <span className="truncate flex-1 text-xs text-left" title={repo.path}>
            {displayName}
          </span>

          {/* Right badges & actions */}
          <div className="flex items-center gap-1 shrink-0">
            {repo.branch && (
              <span
                className="flex items-center gap-1 text-[11px] text-text-muted normal-case truncate max-w-[110px]"
                title={repo.branch}
              >
                <GitBranch size={11} className="shrink-0 opacity-70" />
                <span className="truncate">{repo.branch}</span>
              </span>
            )}

            <button
              type="button"
              title="Sync / Pull"
              onClick={(e) => {
                e.stopPropagation();
                void handleSyncRepo(repo);
              }}
              className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors shrink-0"
            >
              <RefreshCw
                size={11}
                className={syncingRepo === repo.path ? "animate-spin text-brand-500" : ""}
              />
            </button>

            <button
              type="button"
              title={t("git.gitActions", { defaultValue: "Actions" })}
              onClick={(e) => openRepoMenu(repo, e)}
              className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors shrink-0"
            >
              <MoreHorizontal size={11} />
            </button>

            {count > 0 && (
              <span className="px-1 text-[10px] font-medium rounded-brand bg-brand-500/15 text-brand-500 shrink-0">
                {count}
              </span>
            )}
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="flex flex-col border-l border-border-subtle/50 ml-3">
            {repo.children.map((child) => renderRepoItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const selectedRepo = repos.find((r) => r.path === activeRepoPath) || {
    path: activeRepoPath,
    name: workspace?.split("/").pop() || "workspace"
  };

  return (
    <div className="flex flex-col h-full bg-surface select-none">
      {/* Title bar (matches VS Code panel header) */}
      <div
        style={{ height: PANEL_HEADER_HEIGHT }}
        className="bg-surface px-3 border-b border-border flex items-center justify-between flex-shrink-0"
      >
        <span className="uppercase tracking-wider text-xs text-text-muted font-medium">
          {t("git.sourceControl", { defaultValue: "Source Control" })}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title={t("common.refresh", { defaultValue: "Refresh" })}
            onClick={handleRefreshAll}
            className="w-7 h-7 flex items-center justify-center rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-all duration-150 ease-out active:scale-[0.96]"
          >
            <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
          </button>
          {!deep && (
            <button
              type="button"
              title={t("workspaces.scanDeeper", { defaultValue: "Scan Deeper" })}
              onClick={() => {
                vibrate(10);
                scanDeeper();
              }}
              className="w-7 h-7 flex items-center justify-center rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-all duration-150 ease-out active:scale-[0.96]"
            >
              <GitFork size={14} />
            </button>
          )}
          <button
            type="button"
            title={t("git.gitActions", { defaultValue: "More Actions" })}
            onClick={(e) => {
              e.stopPropagation();
              vibrate(10);
              const r = e.currentTarget.getBoundingClientRect();
              setHeaderMenu({ x: Math.min(r.right, window.innerWidth - 180), y: r.bottom + 4 });
            }}
            className="w-7 h-7 flex items-center justify-center rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-all duration-150 ease-out active:scale-[0.96]"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable flex flex-col">
        {/* Section 1: Repositórios */}
        <div className="border-b border-border-subtle flex-shrink-0">
          <button
            type="button"
            onClick={() => {
              vibrate(10);
              setReposExpanded((v) => !v);
            }}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-surface-2/40 hover:bg-surface-2 text-left border-b border-border-subtle transition-colors"
          >
            <ChevronRight
              size={12}
              className={`text-text-muted transition-transform duration-150 ${reposExpanded ? "rotate-90" : ""}`}
            />
            <span className="uppercase tracking-wider text-[11px] text-text-muted font-medium">
              {t("git.repositories", { defaultValue: "Repositories" })}
            </span>
            {repos.length > 0 && (
              <span className="text-[10px] px-1.5 ml-auto rounded-brand bg-surface-3 text-text-muted font-mono">
                {repos.length}
              </span>
            )}
          </button>

          {reposExpanded && (
            <div className="flex flex-col py-0.5">
              {scanning && !repos.length && (
                <div className="flex items-center gap-2 px-4 py-3 text-xs text-text-muted">
                  <Loader2 size={13} className="animate-spin text-brand-500" />
                  <span>{t("common.loading", { defaultValue: "Scanning repositories..." })}</span>
                </div>
              )}

              {!scanning && !repos.length && (
                <div className="px-4 py-3 text-xs text-text-subtle italic">
                  {t("git.noChanges", { defaultValue: "No git repository found in workspace." })}
                </div>
              )}

              {repoTree.map((rootNode) => renderRepoItem(rootNode, 0))}
            </div>
          )}
        </div>

        {/* Section 2: Alterações (Changes) for Selected Repo */}
        <div className="flex-1 min-h-0 flex flex-col">
          <button
            type="button"
            onClick={() => {
              vibrate(10);
              setChangesExpanded((v) => !v);
            }}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-surface-2/40 hover:bg-surface-2 text-left border-b border-border-subtle transition-colors shrink-0"
          >
            <ChevronRight
              size={12}
              className={`text-text-muted transition-transform duration-150 ${changesExpanded ? "rotate-90" : ""}`}
            />
            <span className="uppercase tracking-wider text-[11px] text-text-muted font-medium">
              {t("git.changes", { defaultValue: "Changes" })}
            </span>
            {selectedRepo && (
              <span className="text-text-subtle text-[10px] normal-case truncate max-w-[140px] ml-1">
                ({selectedRepo.name || selectedRepo.relPath || "root"})
              </span>
            )}
          </button>

          {changesExpanded && activeRepoPath && (
            <div className="flex-1 min-h-0 flex flex-col">
              <ScmPanel
                key={activeRepoPath}
                workspace={activeRepoPath}
                fileBus={fileBus}
                onOpenFile={onOpenFile}
                tagDiffWithRepo
                onBranchChanged={refreshRepos}
              />
            </div>
          )}
        </div>
      </div>

      {/* Dropdown context menu for single repository */}
      {repoMenu && (
        <div
          role="menu"
          tabIndex={-1}
          style={{ position: "fixed", left: repoMenu.x, top: repoMenu.y, zIndex: 100 }}
          className="w-48 bg-surface border border-border rounded-brand shadow-lg py-1 text-xs text-text"
        >
          <button
            type="button"
            onClick={async () => {
              setRepoMenu(null);
              await handleSyncRepo(repoMenu.repo);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
          >
            <RefreshCw size={12} className="text-text-muted" />
            <span>{t("git.pull", { defaultValue: "Pull / Sync" })}</span>
          </button>
          <button
            type="button"
            onClick={async () => {
              const p = repoMenu.repo.path;
              setRepoMenu(null);
              await fileBus?.gitPush?.(p);
              refreshRepos();
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
          >
            <GitBranch size={12} className="text-text-muted" />
            <span>{t("git.push", { defaultValue: "Push" })}</span>
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(repoMenu.repo.path);
              } catch {}
              setRepoMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
          >
            <Copy size={12} className="text-text-muted" />
            <span>{t("files.copyPath", { defaultValue: "Copy Path" })}</span>
          </button>
          {fileBus?.revealInOS && (
            <button
              type="button"
              onClick={() => {
                fileBus.revealInOS(repoMenu.repo.path);
                setRepoMenu(null);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
            >
              <ExternalLink size={12} className="text-text-muted" />
              <span>{t("files.revealInOS", { defaultValue: "Reveal in OS" })}</span>
            </button>
          )}
          {fileBus?.openInTerminal && (
            <button
              type="button"
              onClick={() => {
                fileBus.openInTerminal(repoMenu.repo.path);
                setRepoMenu(null);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
            >
              <Terminal size={12} className="text-text-muted" />
              <span>{t("files.openInTerminal", { defaultValue: "Open in Terminal" })}</span>
            </button>
          )}
        </div>
      )}

      {/* Header more menu */}
      {headerMenu && (
        <div
          role="menu"
          tabIndex={-1}
          style={{ position: "fixed", left: headerMenu.x, top: headerMenu.y, zIndex: 100 }}
          className="w-48 bg-surface border border-border rounded-brand shadow-lg py-1 text-xs text-text"
        >
          <button
            type="button"
            onClick={() => {
              setHeaderMenu(null);
              handleRefreshAll();
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
          >
            <RefreshCw size={12} className="text-text-muted" />
            <span>{t("workspaces.refreshRepos", { defaultValue: "Rescan Repositories" })}</span>
          </button>
          {!deep && (
            <button
              type="button"
              onClick={() => {
                setHeaderMenu(null);
                scanDeeper();
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-surface-2 text-left"
            >
              <GitFork size={12} className="text-text-muted" />
              <span>{t("workspaces.scanDeeper", { defaultValue: "Scan Deeper" })}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
