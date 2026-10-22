"use client";

import { useCallback } from "react";

const INVOKE_TIMEOUT_MS = 12000;

export interface BrowserInvokeResult {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

export function useBrowserInvoke(busRef: { current?: any } | null | undefined, profile: string = "default") {
  return useCallback((action: string, payload: Record<string, any> = {}): Promise<BrowserInvokeResult> => {
    return new Promise((resolve) => {
      const bus = busRef?.current;
      if (!bus?.emit) return resolve({ ok: false, error: "Not connected" });
      const fullPayload = { profile, ...payload };
      let settled = false;
      // An old host ignores browser:* events — without this the UI's loading
      // state hangs forever instead of surfacing an error.
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve({ ok: false, error: "No reply from host — restart the host?" }); }
      }, INVOKE_TIMEOUT_MS);
      bus.emit("browser:invoke", { action, payload: fullPayload }, (res: BrowserInvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res || { ok: false, error: "No reply from host" });
      });
    });
  }, [busRef, profile]);
}
