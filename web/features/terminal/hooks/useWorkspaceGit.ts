"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import { GIT_REFRESH_EVENT } from "@/features/fileExplorer/constants/fileExplorer.js";

export interface WorkspaceGitState {
  branch: string | null;
  dirty: boolean;
  changedCount: number;
}

interface WorkspaceGitEntry {
  state: WorkspaceGitState;
  stop: (() => void) | null;
  seq: number;
  refs: number;
  subs: Set<(state: WorkspaceGitState) => void>;
  fileBus: any;
  onRefresh?: () => void;
}

// Shared, ref-counted git branch + dirty flag per workspace path. One poll per unique
// path no matter how many terminals sit in that workspace — otherwise 10 terminals in
// one repo mean 10 identical `git` calls every tick.
const entries = new Map<string, WorkspaceGitEntry>(); // path → { state, stop, refs, subs, fileBus }

const EMPTY: WorkspaceGitState = { branch: null, dirty: false, changedCount: 0 };

function notify(entry: WorkspaceGitEntry): void {
  entry.subs.forEach((fn) => fn(entry.state));
}

async function fetchOnce(entry: WorkspaceGitEntry, wsPath: string, force?: boolean): Promise<void> {
  const seq = ++entry.seq;
  const [branchRes, countRes] = await Promise.all([
    entry.fileBus?.gitBranch?.(wsPath),
    entry.fileBus?.gitChangedCount?.(wsPath, force)
  ]);
  // A slower, older reply must not overwrite a newer one (poll racing a forced refresh).
  if (seq !== entry.seq) return;
  const branch = branchRes?.success ? branchRes.branch || null : null;
  const changedCount = countRes?.success ? countRes.count || 0 : 0;
  if (entry.state.branch === branch && entry.state.changedCount === changedCount) return;
  entry.state = { branch, dirty: changedCount > 0, changedCount };
  notify(entry);
}

function acquire(wsPath: string, fileBus: any): WorkspaceGitEntry {
  let entry = entries.get(wsPath);
  if (!entry) {
    entry = { state: EMPTY, stop: null, seq: 0, refs: 0, subs: new Set(), fileBus };
    entries.set(wsPath, entry);
    fetchOnce(entry, wsPath);
    entry.stop = pollWhileVisible(() => fetchOnce(entry!, wsPath), WORKSPACE_GIT_POLL_MS);
    // Commit/discard/push announce themselves here; bypass the TTL so the badge drops at once.
    entry.onRefresh = () => fetchOnce(entry!, wsPath, true);
    window.addEventListener(GIT_REFRESH_EVENT, entry.onRefresh);
  }
  entry.refs++;
  return entry;
}

function release(wsPath: string): void {
  const entry = entries.get(wsPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.stop?.();
  if (entry.onRefresh) window.removeEventListener(GIT_REFRESH_EVENT, entry.onRefresh);
  entries.delete(wsPath);
}

// Force a refresh for a path (after checkout / commit) without waiting for the poll.
export function refreshWorkspaceGit(wsPath: string): void {
  const entry = entries.get(wsPath);
  if (entry) fetchOnce(entry, wsPath, true);
}

export function useWorkspaceGit(
  wsPath?: string | null,
  propFileBus?: any,
  { enabled = true }: { enabled?: boolean } = {}
): WorkspaceGitState {
  const [state, setState] = useState<WorkspaceGitState>(EMPTY);
  const fileBus = propFileBus || useFileBusStore.getState();

  useEffect(() => {
    if (!wsPath || !fileBus || !enabled) return;
    const entry = acquire(wsPath, fileBus);
    entry.subs.add(setState);
    // Adopt whatever the shared entry already knows, without a redundant render when
    // this is the subscriber that just created it.
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(wsPath);
    };
  }, [wsPath, fileBus, enabled]);

  return state;
}
