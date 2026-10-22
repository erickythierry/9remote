"use client";

import { useCallback, useEffect, useState } from "react";
import { useFileBusStore } from "@/shared/stores/fileBusStore";

export interface WorkspaceRootItem {
  path: string;
  branch: string | null;
  name: string;
  isMain?: boolean;
}

export interface UseWorkspaceRootsResult {
  roots: WorkspaceRootItem[];
  refresh: () => Promise<void>;
}

const basename = (p: string) => (p || "").split("/").filter(Boolean).pop() || p;

// Roots the file tree shows: the workspace plus each of its worktrees. They are separate
// directories on disk, so one tree cannot contain them — each gets its own root section.
export function useWorkspaceRoots(workspacePath?: string | null, propFileBus?: any): UseWorkspaceRootsResult {
  const [roots, setRoots] = useState<WorkspaceRootItem[]>([]);
  const fileBus = propFileBus || useFileBusStore.getState();

  const load = useCallback(async () => {
    if (!workspacePath || !fileBus?.gitWorktreeList) {
      setRoots([]);
      return;
    }
    const res = await fileBus.gitWorktreeList(workspacePath);
    if (!res?.success || !res.worktrees?.length) {
      // Not a repo, or git unavailable — the workspace folder is still a valid root.
      setRoots([{ path: workspacePath, branch: null, name: basename(workspacePath) }]);
      return;
    }
    setRoots(res.worktrees.map((wt: any) => ({
      path: wt.path,
      branch: wt.branch,
      name: basename(wt.path),
      isMain: wt.isMain
    })));
  }, [workspacePath, fileBus]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  return { roots, refresh: load };
}
