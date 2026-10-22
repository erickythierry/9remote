"use client";

import { create } from "zustand";
import { isHostEnvironment } from "@/shared/utils/localOrigin";

declare global {
  interface Window {
    __logCapture?: boolean;
  }
}

type LogLevel = "debug" | "info" | "warn" | "error";
type LogSource = "web" | "host";

interface LogEntry {
  id: number;
  ts: string;
  source: LogSource;
  level: LogLevel;
  domain: string;
  msg: string;
}

interface LogState {
  entries: LogEntry[];
  push: (entry: LogEntry) => void;
  clear: () => void;
  loadHostTail: () => Promise<void>;
  startHostTail: () => void;
  stopHostTail: () => void;
}

// Unified debug log buffer: web console + host tail, rendered in Settings → Debug.
const MAX_ENTRIES = 500;
// Host log lines: `2026-09-27T10:00:00.123Z INFO [domain] message`
const HOST_LINE_RE = /^(\S+) (DEBUG|INFO|WARN|ERROR) \[([^\]]+)\] (.*)$/;
const HOST_TAIL_LINES = 200;

let seq = 0;
let tail: EventSource | null = null; // the debug pane's own SSE subscription (host env only)

function entry(source: LogSource, level: LogLevel, domain: string, msg: string, ts?: string): LogEntry {
  return { id: ++seq, ts: ts || new Date().toISOString(), source, level, domain, msg };
}

function hostLineToEntry(line: string): LogEntry {
  const m = HOST_LINE_RE.exec(line);
  return m ? entry("host", m[2].toLowerCase() as LogLevel, m[3], m[4], m[1]) : entry("host", "info", "host", line);
}

function fmtArgs(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(" ");
}

export const useLogStore = create<LogState>((set, get) => ({
  entries: [],
  push: (e) => set((s) => {
    const next = [...s.entries, e];
    return { entries: next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next };
  }),
  clear: () => set({ entries: [] }),
  // Swap in the host file's tail (longer history than the ring buffer saw)
  loadHostTail: async () => {
    if (!isHostEnvironment()) return;
    try {
      const r = await fetch(`/api/logs?lines=${HOST_TAIL_LINES}`, { cache: "no-store" });
      const d: { logs?: string[] } = await r.json();
      if (!Array.isArray(d?.logs)) return;
      const web = get().entries.filter((e) => e.source === "web");
      set({ entries: [...d.logs.map(hostLineToEntry), ...web].slice(-MAX_ENTRIES) });
    } catch {}
  },
  // Live host tail over the local SSE bus — only while the debug pane is open.
  startHostTail: () => {
    if (!isHostEnvironment() || tail) return;
    tail = new EventSource("/api/ui/events");
    tail.onmessage = (e) => {
      let data: { type?: string; message?: string };
      try { data = JSON.parse(e.data); } catch { return; }
      if (data?.type === "log" && data.message) get().push(hostLineToEntry(data.message));
    };
  },
  stopHostTail: () => { tail?.close(); tail = null; }
}));

// Capture console + global errors into the buffer; the original console stays intact.
if (typeof window !== "undefined" && !window.__logCapture) {
  window.__logCapture = true;
  const push = useLogStore.getState().push;
  const wrap = (method: "log" | "info" | "warn" | "error" | "debug", level: LogLevel) => {
    const orig = console[method];
    console[method] = (...args: unknown[]) => {
      try { push(entry("web", level, "web", fmtArgs(args))); } catch {}
      orig(...args);
    };
  };
  wrap("log", "info");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");
  wrap("debug", "debug");
  window.addEventListener("error", (e) => push(entry("web", "error", "web", e.message)));
  window.addEventListener("unhandledrejection", (e) => push(entry("web", "error", "web", `Unhandled rejection: ${e.reason}`)));
}
