"use client";

import { useCallback, useEffect, useState } from "react";
import { isHostEnvironment } from "@/shared/utils/localOrigin";

export interface SleepSettings {
  mode: string;
  presets: string[];
}

export interface DesktopUnlockPayload {
  enabled?: boolean;
  busy?: boolean;
  [key: string]: unknown;
}

// Host-local settings, reachable only on the origin the host itself serves
// (same localhost-only APIs the host dashboard uses). Outside that context
// every call is skipped and the state stays inert.
export function useHostLocalSettings() {
  const [autoStart, setAutoStart] = useState<boolean | null>(null); // null = unknown yet
  const [unlock, setUnlock] = useState<DesktopUnlockPayload | null>(null); // host /api/desktop-unlock payload
  const [sleep, setSleep] = useState<SleepSettings | null>(null); // { mode, presets } from /api/sleep-inhibit

  useEffect(() => {
    if (!isHostEnvironment()) return;
    fetch("/api/autostart", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setAutoStart(!!d?.enabled)).catch(() => {});
    fetch("/api/desktop-unlock", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setUnlock(d)).catch(() => {});
    fetch("/api/sleep-inhibit", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setSleep({ mode: d?.mode || "never", presets: Array.isArray(d?.presets) ? d.presets : [] }))
      .catch(() => {});
  }, []);

  const refreshUnlock = useCallback(() => {
    fetch("/api/desktop-unlock", { cache: "no-store" }).then((r) => r.json())
      .then((d) => setUnlock(d)).catch(() => {});
  }, []);

  // Optimistic toggle — the POST answers no payload, so rollback only on failure.
  const toggleAutoStart = useCallback((next: boolean) => {
    setAutoStart(next);
    fetch("/api/autostart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next })
    }).catch(() => setAutoStart((cur) => (cur === next ? !next : cur)));
  }, []);

  const toggleUnlock = useCallback(() => {
    const action = unlock?.enabled ? "uninstall" : "install";
    setUnlock((u) => (u ? { ...u, busy: true } : u));
    fetch(`/api/desktop-unlock/${action}`, { method: "POST" })
      .then(refreshUnlock)
      .catch(refreshUnlock);
  }, [unlock, refreshUnlock]);

  const stopHost = useCallback(() => {
    fetch("/api/ui/stop", { method: "POST" }).catch(() => {});
  }, []);

  const shutdownHost = useCallback(() => {
    fetch("/api/ui/shutdown", { method: "POST" }).catch(() => {});
  }, []);

  // Optimistic preset change — the POST answers the settled mode, so rollback only on failure.
  const setSleepMode = useCallback((mode: string) => {
    let prev: string | null = null;
    setSleep((s) => { prev = s?.mode || null; return s ? { ...s, mode } : s; });
    fetch("/api/sleep-inhibit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    }).then((r) => r.json())
      .then((d) => {
        if (d?.mode) setSleep((s) => (s ? { ...s, mode: d.mode } : s));
        else if (prev) { const p = prev; setSleep((s) => (s ? { ...s, mode: p } : s)); }
      })
      .catch(() => { if (prev) { const p = prev; setSleep((s) => (s ? { ...s, mode: p } : s)); } });
  }, []);

  return {
    autoStart,
    unlock,
    sleep,
    toggleAutoStart,
    toggleUnlock,
    setSleepMode,
    stopHost,
    shutdownHost,
    stopAgent: stopHost,
    shutdownAgent: shutdownHost
  };
}
export const useAgentLocalSettings = useHostLocalSettings;
