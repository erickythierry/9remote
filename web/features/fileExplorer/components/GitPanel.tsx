"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  GitFork,
  Loader2,
  GitBranch,
  ArrowUp,
  ArrowDown
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { GIT_REFRESH_EVENT } from "../constants/fileExplorer";
import { useWorkspaceRepos } from "@/features/terminal/hooks/useWorkspaceRepos";
import { useWorkspaceChangedCount, refreshWorkspaceChangedCount } from "@/features/terminal/hooks/useWorkspaceChangedCount";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import ScmPanel from "./ScmPanel";

export interface WorkspaceRepoItem {
  path: string;
  name: string;
  relPath?: string;
  branch?: string | null;
  changedCount?: number;
  [key: string]: any;
}

interface GitPanelProps {
  workspace: string;
  fileBus: any;
  onBack?: () => void;
  onOpenFile?: (path: string) => void;
}

export default function GitPanel({ workspace, fileBus, onBack, onOpenFile }: GitPanelProps) {
  const { t } = useI18n();

  const { repos, refresh: refreshRepos, scanning, deep, scanDeeper } = useWorkspaceRepos(workspace, fileBus) as {
    repos: WorkspaceRepoItem[];
    refresh: () => void;
    scanning: boolean;
    deep: boolean;
    scanDeeper: () => void;
  };
  const { perRepo: livePerRepo, syncPerRepo } = useWorkspaceChangedCount(workspace, fileBus) as {
    perRepo: Record<string, number>;
    syncPerRepo: Record<string, { ahead?: number; behind?: number }>;
  };
  const { branch: liveBranch } = useWorkspaceGit(workspace, fileBus);

  // Rescan when branch changes externally
  const lastBranchRef = useRef<{ path: string | null; branch: string | null }>({ path: null, branch: null });
  useEffect(() => {
    const seen = lastBranchRef.current;
    lastBranchRef.current = { path: workspace, branch: liveBranch };
    if (seen.path !== workspace || seen.branch === null || seen.branch === liveBranch) return;
    refreshRepos();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(GIT_REFRESH_EVENT));
    }
  }, [liveBranch, workspace, refreshRepos]);

  // Fallback if gitScanRepos returned empty but the workspace itself is a git repo
  const [rootRepoFallback, setRootRepoFallback] = useState<WorkspaceRepoItem | null>(null);
  useEffect(() => {
    if (scanning || repos.length > 0 || !workspace || !fileBus?.gitBranch) return;
    let cancelled = false;
    fileBus.gitBranch(workspace).then((res: any) => {
      if (cancelled) return;
      if (res?.success) {
        setRootRepoFallback({
          path: workspace,
          name: workspace.split("/").filter(Boolean).pop() || "workspace",
          relPath: "",
          branch: res.branch || null,
          changedCount: 0
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [scanning, repos.length, workspace, fileBus]);

  const effectiveRepos = useMemo(() => {
    if (repos.length > 0) return repos;
    return rootRepoFallback ? [rootRepoFallback] : [];
  }, [repos, rootRepoFallback]);

  const countOf = useCallback(
    (repo: WorkspaceRepoItem) => {
      return livePerRepo[repo.path] ?? repo.changedCount ?? 0;
    },
    [livePerRepo]
  );

  const [showCleanRepos, setShowCleanRepos] = useState(true);
  const isMainRepo = useCallback(
    (repo: WorkspaceRepoItem) => !repo.relPath || repo.path === workspace,
    [workspace]
  );

  const gitRepos = useMemo(() => {
    if (showCleanRepos) return effectiveRepos;
    return effectiveRepos.filter((r) => countOf(r) > 0 || isMainRepo(r));
  }, [effectiveRepos, showCleanRepos, countOf, isMainRepo]);

  const dirtyRepos = useMemo(() => effectiveRepos.filter((r) => countOf(r) > 0), [effectiveRepos, countOf]);
  const dirtyCount = useMemo(
    () => dirtyRepos.reduce((n, r) => n + countOf(r), 0),
    [dirtyRepos, countOf]
  );
  const hiddenCleanCount = showCleanRepos ? 0 : effectiveRepos.length - gitRepos.length;

  const [openRepo, setOpenRepo] = useState<string | null>(null);

  // Auto-expand single repo or first dirty repo
  const activeRepo = useMemo(() => {
    if (openRepo !== null) return openRepo;
    if (gitRepos.length === 1) return gitRepos[0].path;
    if (dirtyRepos.length > 0) return dirtyRepos[0].path;
    return null;
  }, [openRepo, gitRepos, dirtyRepos]);

  return (
    <div className="h-full bg-bg flex flex-col select-none">
      {/* Header */}
      <div className="bg-surface border-b border-border px-3 py-2.5 flex items-center gap-3 flex-shrink-0">
        <button
          type="button"
          onClick={() => {
            vibrate();
            onBack?.();
          }}
          className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
          title={t("common.back", { defaultValue: "Back" })}
        >
          <ChevronLeft size={20} />
        </button>

        <h1 className="text-text text-base font-semibold truncate flex items-center gap-2">
          {t("git.title", { defaultValue: "Git" })}
          {dirtyCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-semibold rounded-full bg-brand-500/15 text-brand-500">
              {dirtyCount}
            </span>
          )}
          {gitRepos.length === 1 && gitRepos[0]?.branch && (
            <span className="text-text-muted font-normal text-xs truncate max-w-[150px]">
              · {gitRepos[0].branch}
            </span>
          )}
        </h1>

        <div className="ml-auto flex items-center gap-1">
          {!deep && (
            <button
              type="button"
              onClick={() => {
                vibrate();
                scanDeeper();
              }}
              className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
              title={t("workspaces.scanDeeper", { defaultValue: "Scan deeper" })}
            >
              <GitFork size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              vibrate();
              refreshRepos();
              window.dispatchEvent(new Event(GIT_REFRESH_EVENT));
              refreshWorkspaceChangedCount(workspace);
            }}
            className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
            title={t("common.refresh", { defaultValue: "Refresh" })}
          >
            <RefreshCw size={16} className={scanning ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Content */}
      {scanning && !effectiveRepos.length ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-text-muted gap-2">
          <Loader2 size={24} className="animate-spin text-brand-500" />
          <span className="text-xs">{t("common.loading", { defaultValue: "Loading..." })}</span>
        </div>
      ) : !gitRepos.length ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-text-muted text-center gap-3">
          <GitBranch size={32} className="opacity-40" />
          <p className="text-sm">{t("files.noGitRepo", { defaultValue: "No Git repository found" })}</p>
          {!deep && (
            <button
              type="button"
              onClick={() => {
                vibrate();
                scanDeeper();
              }}
              className="px-3 py-1.5 text-xs bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-colors"
            >
              {t("workspaces.scanDeeper", { defaultValue: "Scan deeper" })}
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable bg-bg">
          {gitRepos.map((repo) => {
            const displayName = repo.relPath || repo.name;
            const count = countOf(repo);
            const isOpen = activeRepo === repo.path;
            const { ahead = 0, behind = 0 } = syncPerRepo[repo.path] || {};

            return (
              <div key={repo.path} className="border-b border-border-subtle last:border-0">
                <button
                  type="button"
                  onClick={() => {
                    vibrate();
                    setOpenRepo(isOpen ? "" : repo.path);
                  }}
                  className="group/repo w-full sticky top-0 z-10 px-3 py-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-muted hover:text-text bg-surface-3 border-b border-border-subtle transition-colors"
                >
                  <ChevronRight
                    size={12}
                    className={`flex-shrink-0 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
                  />
                  <span className="truncate flex-1 text-left font-medium" title={displayName}>
                    {displayName}
                  </span>
                  {ahead > 0 && (
                    <span
                      className="flex items-center text-[11px] normal-case tracking-normal text-brand-500 flex-shrink-0"
                      title={`${ahead} to push`}
                    >
                      <ArrowUp size={11} />
                      {ahead}
                    </span>
                  )}
                  {behind > 0 && (
                    <span
                      className="flex items-center text-[11px] normal-case tracking-normal text-amber-500 flex-shrink-0"
                      title={`${behind} to pull`}
                    >
                      <ArrowDown size={11} />
                      {behind}
                    </span>
                  )}
                  {repo.branch && (
                    <span
                      className="text-text-subtle normal-case tracking-normal truncate max-w-[45%] text-[11px]"
                      title={repo.branch}
                    >
                      {repo.branch}
                    </span>
                  )}
                  {count > 0 && (
                    <span className="px-1.5 py-0.5 rounded-[2px] bg-brand-500/15 text-brand-500 text-[11px] font-semibold normal-case tracking-normal flex-shrink-0">
                      {count}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="bg-bg">
                    <ScmPanel
                      workspace={repo.path}
                      fileBus={fileBus}
                      onOpenFile={onOpenFile}
                      tagDiffWithRepo
                      onBranchChanged={refreshRepos}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {(hiddenCleanCount > 0 || !deep) && (
            <div className="border-t border-border-subtle p-2 space-y-1">
              {hiddenCleanCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    vibrate();
                    setShowCleanRepos(true);
                  }}
                  className="w-full px-3 py-1.5 text-xs text-text-subtle hover:text-text hover:bg-surface-2 rounded-brand transition-colors text-left"
                >
                  {t("workspaces.showCleanRepos", { count: hiddenCleanCount })}
                </button>
              )}
              {!deep && (
                <button
                  type="button"
                  onClick={() => {
                    vibrate();
                    scanDeeper();
                  }}
                  className="w-full px-3 py-1.5 text-xs text-text-subtle hover:text-text hover:bg-surface-2 rounded-brand transition-colors text-left"
                >
                  {t("workspaces.scanDeeper")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}