// Duration formatting for the task strip and its modal. Seconds below a minute, because
// a sub-agent's first ten seconds are exactly what a reader is watching; above that the
// seconds stop mattering and the minutes do.

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "12s", "1m 04s", "1h 02m" — the same span in the strip and in the modal. */
export function clockText(ms: unknown): string {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/** Formats task creation timestamp as local time (e.g. "14:35:10"). */
type TaskTimeInput = {
  startedAt?: string | number | null;
  createdAt?: string | number | null;
  endedAt?: number | null;
  usage?: { duration_ms?: number | null } | null;
};

export function taskStartTime(task: TaskTimeInput | null | undefined): string {
  const ts = task?.startedAt || task?.createdAt || (task?.endedAt && task?.usage?.duration_ms ? task.endedAt - task.usage.duration_ms : null);
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
}

/** The CLI reports task usage in ms; the modal prints it as a span, not a count. */
export const usageDurationMs = (usage: { duration_ms?: unknown } | null | undefined): number => Number(usage?.duration_ms) || 0;
