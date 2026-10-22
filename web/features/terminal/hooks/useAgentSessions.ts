"use client";

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { AGENT_HISTORY_TTL_MS } from "@/features/terminal/constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";
import type { AgentHistoryRow } from "@/shared/stores/terminalTypes";

interface PollerEntry {
  count: number;
  fetchNow: () => void;
  stop: () => void;
}

// One poller per host-scoped directory, however many panels read it. The sidebar
// and the new-terminal modal show the same list side by side on desktop; a poller
// each would double the `getAgentSessions` round-trips over the tunnel for one
// answer. The scope prefix keeps two machines' identical paths apart.
const pollers = new Map<string, PollerEntry>(); // `${scope}|${cwd}` -> { count, fetchNow, stop }
// A lazy bus may still be opening when the first fetch fires — retry quietly
// instead of burning the poll cycle on a no-op.
const BUS_WAIT_RETRY_MS = 1000;

const historyKey = (scope: string, cwd: string): string => (scope ? `${scope}|${cwd}` : cwd);

function acquirePoller(busRef: { current?: any }, scope: string, cwd: string): PollerEntry {
  const key = historyKey(scope, cwd);
  const existing = pollers.get(key);
  if (existing) {
    existing.count += 1;
    return existing;
  }
  // Invalidation backdates every cwd at once, so each reader would ask on the same
  // tick. One request answers all of them. The closure holds the REF, not the bus —
  // fetchNow always reads the live facade, so a bus opening later just works.
  let inFlight = false;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  const fetchNow = () => {
    const bus = busRef?.current;
    if (!bus) { waitTimer = setTimeout(fetchNow, BUS_WAIT_RETRY_MS); return; }
    if (inFlight) return;
    inFlight = true;
    bus.emit("getAgentSessions", { cwd }, (result: any) => {
      inFlight = false;
      if (Array.isArray(result?.sessions)) useTerminalStore.getState().setAgentHistory(key, result.sessions);
    });
  };
  const stopPoll = pollWhileVisible(fetchNow, AGENT_HISTORY_TTL_MS);
  const entry: PollerEntry = {
    count: 1,
    fetchNow,
    stop: () => { if (waitTimer) clearTimeout(waitTimer); stopPoll(); }
  };
  pollers.set(key, entry);
  return entry;
}

function releasePoller(scope: string, cwd: string): void {
  const entry = pollers.get(historyKey(scope, cwd));
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0) return;
  entry.stop();
  pollers.delete(historyKey(scope, cwd));
}

// Past conversations the agent CLIs (Claude Code, Codex, OpenCode, …) kept for
// this directory on THIS host. Refetches when the terminal moves to another cwd,
// and on a TTL tick while it stays: a conversation started in the terminal above
// is being written to its store right now, and should appear without a reload.
export function useAgentSessions(busRef: { current?: any }, cwd?: string | null, scope = ""): AgentHistoryRow[] | null {
  const key = cwd ? historyKey(scope, cwd) : null;
  const entry = useTerminalStore((s) => (key ? s.agentHistory[key] : null));
  // Closing a terminal backdates every cwd's rows; refetching on that timestamp
  // is what turns the invalidation into a refresh instead of a 30s wait.
  const staleAt = entry?.at ?? 0;

  useEffect(() => {
    if (!cwd) return;
    const poller = acquirePoller(busRef, scope, cwd);
    // A second reader joining an already-warm poller must not re-ask on its own —
    // only a cache that has actually aged out is worth a fetch.
    const cached = useTerminalStore.getState().agentHistory[historyKey(scope, cwd)];
    if (!cached || Date.now() - cached.at >= AGENT_HISTORY_TTL_MS) poller.fetchNow();
    return () => releasePoller(scope, cwd);
  }, [busRef, cwd, scope, staleAt]);

  return entry?.sessions || null;
}
