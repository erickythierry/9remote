"use client";

import { useCallback, useEffect, useState } from "react";
import { REPO_SCAN } from "../constants/terminalConfig";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import { GIT_REFRESH_EVENT } from "@/features/fileExplorer/constants/fileExplorer.js";

export interface WorkspaceRepoItem {
  path: string;
  name?: string;
  [key: string]: any;
}

export interface UseWorkspaceReposResult {
  repos: WorkspaceRepoItem[];
  refresh: () => Promise<void>;
  scanning: boolean;
  deep: boolean;
  scanDeeper: () => void;
}

// Repos found at or under a workspace root. The agent memoizes the disk walk; this hook
// only holds the result and exposes an explicit refresh, so switching tabs never rescans.
export function useWorkspaceRepos(rootPath?: string | null, propFileBus?: any): UseWorkspaceReposResult {
  const [repos, setRepos] = useState<WorkspaceRepoItem[]>([]);
  const [scanning, setScanning] = useState(false);
  const fileBus = propFileBus || useFileBusStore.getState();
  // Deep by default: monorepos whose real repos live at packages/*/ are found immediately.
  const [deep, setDeep] = useState(true);

  const scan = useCallback(async (force?: boolean, deepScan?: boolean): Promise<boolean> => {
    if (!rootPath || !fileBus?.gitScanRepos) return true;
    setScanning(true);
    if (force) await fileBus.gitRefreshRepos?.(rootPath);
    const depth = deepScan ? REPO_SCAN.deepMaxDepth : REPO_SCAN.maxDepth;
    const res = await fileBus.gitScanRepos(rootPath, depth, force);
    setScanning(false);
    setRepos(res?.success ? res.repos || [] : []);
    return !!res?.success;
  }, [rootPath, fileBus]);

  // Deferred: the scan flips `scanning` immediately, which must not run synchronously
  // inside the effect body.
  // A scan that failed (a new terminal's bus not connected yet) is retried, or the list stays empty until a manual refresh.
  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async (left: number) => {
      const ok = await scan(false, deep);
      if (ok || dead || left <= 0) return;
      timer = setTimeout(() => void attempt(left - 1), REPO_SCAN.retryMs);
    };
    timer = setTimeout(() => void attempt(REPO_SCAN.retries), 0);
    return () => { dead = true; clearTimeout(timer); };
  }, [scan, deep]);

  // Rescan on external git refresh events (e.g. branch checkout, commits)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void scan(false, deep);
    window.addEventListener(GIT_REFRESH_EVENT, handler);
    return () => window.removeEventListener(GIT_REFRESH_EVENT, handler);
  }, [scan, deep]);

  const refresh = useCallback(async () => { await scan(true, deep); }, [scan, deep]);
  const scanDeeper = useCallback(() => setDeep(true), []);

  return { repos, refresh, scanning, deep, scanDeeper };
}
