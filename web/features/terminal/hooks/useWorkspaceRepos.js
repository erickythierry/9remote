"use client";

import { useCallback, useEffect, useState } from "react";
import { REPO_SCAN } from "../constants/terminalConfig";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import { GIT_REFRESH_EVENT } from "@/features/fileExplorer/constants/fileExplorer.js";

// Repos found at or under a workspace root. The agent memoizes the disk walk; this hook
// only holds the result and exposes an explicit refresh, so switching tabs never rescans.
export function useWorkspaceRepos(rootPath, propFileBus) {
  const [repos, setRepos] = useState([]);
  const [scanning, setScanning] = useState(false);
  const fileBus = propFileBus || useFileBusStore.getState();
  // Deep by default: monorepos whose real repos live at packages/*/ are found immediately.
  const [deep, setDeep] = useState(true);

  const scan = useCallback(async (force, deepScan) => {
    if (!rootPath || !fileBus?.gitScanRepos) return;
    setScanning(true);
    if (force) await fileBus.gitRefreshRepos?.(rootPath);
    const depth = deepScan ? REPO_SCAN.deepMaxDepth : REPO_SCAN.maxDepth;
    const res = await fileBus.gitScanRepos(rootPath, depth, force);
    setScanning(false);
    setRepos(res?.success ? res.repos || [] : []);
  }, [rootPath, fileBus]);

  // Deferred: the scan flips `scanning` immediately, which must not run synchronously
  // inside the effect body.
  useEffect(() => {
    const id = setTimeout(() => void scan(false, deep), 0);
    return () => clearTimeout(id);
  }, [scan, deep]);

  // Rescan on external git refresh events (e.g. branch checkout, commits)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void scan(false, deep);
    window.addEventListener(GIT_REFRESH_EVENT, handler);
    return () => window.removeEventListener(GIT_REFRESH_EVENT, handler);
  }, [scan, deep]);

  const refresh = useCallback(() => scan(true, deep), [scan, deep]);
  const scanDeeper = useCallback(() => setDeep(true), []);

  return { repos, refresh, scanning, deep, scanDeeper };
}
