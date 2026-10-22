"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS, WORKSPACE_GIT_FETCH_MS, REPO_SCAN } from "../constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";
import { GIT_REFRESH_EVENT } from "@/features/fileExplorer/constants/fileExplorer.js";

export interface WorkspaceChangedState {
  count: number;
  perRepo: Record<string, number>;
  syncPerRepo: Record<string, any>;
}

interface WorkspaceChangedEntry {
  state: WorkspaceChangedState;
  stop: (() => void) | null;
  stopFetch?: (() => void) | null;
  seq: number;
  refs: number;
  subs: Set<(state: WorkspaceChangedState) => void>;
  fileBus: any;
  onRefresh?: () => void;
}

// One changed-file count per workspace root, covering the root repo and every repo under
// it. Ref-counted and shared, so the terminal badge and the git panel read the same
// number from a single poll instead of counting separately and disagreeing.
const entries = new Map<string, WorkspaceChangedEntry>(); // rootPath → { state, stop, refs, subs, fileBus }

const EMPTY: WorkspaceChangedState = { count: 0, perRepo: {}, syncPerRepo: {} };

function fetchOnce(entry: WorkspaceChangedEntry, rootPath: string, force?: boolean, fetch?: boolean): void {
  const seq = ++entry.seq;
  entry.fileBus?.gitWorkspaceChangedCount?.(rootPath, REPO_SCAN.maxDepth, force, fetch).then((res: any) => {
    // A slower, older reply must not overwrite a newer one (poll racing a forced refresh).
    if (!res?.success || seq !== entry.seq) return;
    entry.state = { count: res.count || 0, perRepo: res.perRepo || {}, syncPerRepo: res.syncPerRepo || {} };
    entry.subs.forEach((fn) => fn(entry.state));
  });
}

function acquire(rootPath: string, fileBus: any): WorkspaceChangedEntry {
  let entry = entries.get(rootPath);
  if (!entry) {
    entry = { state: EMPTY, stop: null, seq: 0, refs: 0, subs: new Set(), fileBus };
    entries.set(rootPath, entry);
    fetchOnce(entry, rootPath);
    entry.stop = pollWhileVisible(() => fetchOnce(entry!, rootPath), WORKSPACE_GIT_POLL_MS);
    entry.stopFetch = pollWhileVisible(() => fetchOnce(entry!, rootPath, false, true), WORKSPACE_GIT_FETCH_MS);
    // Commits, discards and manual refresh announce themselves here; bypass the TTL so the count drops at once.
    entry.onRefresh = () => fetchOnce(entry!, rootPath, true);
    window.addEventListener(GIT_REFRESH_EVENT, entry.onRefresh);
  }
  entry.refs++;
  return entry;
}

function release(rootPath: string): void {
  const entry = entries.get(rootPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.stop?.();
  entry.stopFetch?.();
  if (entry.onRefresh) window.removeEventListener(GIT_REFRESH_EVENT, entry.onRefresh);
  entries.delete(rootPath);
}

// Force a refresh for a workspace (after commit / discard / refresh button) without
// waiting for the poll. Forces past the agent-side TTL cache and also runs `git fetch`.
export function refreshWorkspaceChangedCount(rootPath: string): void {
  const entry = entries.get(rootPath);
  if (entry) fetchOnce(entry, rootPath, true, true);
}

export function useWorkspaceChangedCount(
  rootPath?: string | null,
  fileBus?: any,
  { enabled = true }: { enabled?: boolean } = {}
): WorkspaceChangedState {
  const [state, setState] = useState<WorkspaceChangedState>(EMPTY);

  useEffect(() => {
    if (!rootPath || !fileBus || !enabled) return;
    const entry = acquire(rootPath, fileBus);
    entry.subs.add(setState);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latch shared entry state on subscribe; identity-guarded
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(rootPath);
    };
  }, [rootPath, fileBus, enabled]);

  return state;
}
