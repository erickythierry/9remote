// Reading of the sessionStatus map shared by the desktop bell and the mobile badge:
// two places counting "how many need me" separately is two places to disagree.

export interface SessionStatusEntry {
  state?: string;
  tool?: string;
  since?: number;
  [key: string]: unknown;
}

export interface StatusItem {
  id: string;
  state: string;
  tool?: string;
  since?: number;
}

export interface AttentionSummary {
  blocked: number;
  done: number;
  total: number;
  targetId: string | null;
}

// Attention order — what the user should be taken to first.
const STATE_RANK: Record<string, number> = { working: 0, blocked: 1, done: 2, idle: 3 };

/** Merge the status map onto the session list, non-idle first, newest first within a state. */
export function statusItems(
  sessionStatus: Record<string, SessionStatusEntry> = {},
  allSessions: Array<{ id: string; [key: string]: unknown }> = []
): StatusItem[] {
  const items: StatusItem[] = allSessions.length
    ? allSessions.map((s) => {
        const st = sessionStatus[s.id];
        return { id: s.id, state: st?.state || "idle", tool: st?.tool, since: st?.since };
      })
    : Object.entries(sessionStatus).map(([id, st]) => ({
        id,
        state: st?.state || "idle",
        tool: st?.tool,
        since: st?.since
      }));
  return items.sort((a, b) => {
    const rank = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    return rank !== 0 ? rank : (b.since || 0) - (a.since || 0);
  });
}

/** Counts worth a badge, plus the session a tap should land on. */
export function attentionSummary(
  sessionStatus: Record<string, SessionStatusEntry> = {},
  allSessions: Array<{ id: string; [key: string]: unknown }> = []
): AttentionSummary {
  const items = statusItems(sessionStatus, allSessions);
  const blocked = items.filter((it) => it.state === "blocked");
  const done = items.filter((it) => it.state === "done");
  return {
    blocked: blocked.length,
    done: done.length,
    total: blocked.length + done.length,
    // A session waiting on the user outranks one that has already finished.
    targetId: blocked[0]?.id || done[0]?.id || null
  };
}
