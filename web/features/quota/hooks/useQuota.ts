"use client";

import { useEffect, useState } from "react";
import { QUOTA_POLL_MS } from "../constants/quotaConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";

export interface QuotaWindow {
  usedPercent: number;
  resetsAt?: string | null;
  [key: string]: unknown;
}

export interface QuotaProviderData {
  provider: string;
  status?: string;
  session?: QuotaWindow | null;
  weekly?: QuotaWindow | null;
  monthly?: QuotaWindow | null;
  buckets?: Array<{ name: string; usedPercent: number; resetsAt?: string | null }>;
  error?: string | null;
  [key: string]: unknown;
}

export interface QuotaResponse {
  success: boolean;
  providers?: Record<string, QuotaProviderData>;
  [key: string]: unknown;
}

export interface UseQuotaOptions {
  enabled?: boolean;
}

// Polls the agent's aggregate quota:get (agent caches for 60s server-side).
// Returns null until the first successful response.
export function useQuota(
  busRef?: React.MutableRefObject<any> | null,
  { enabled = true }: UseQuotaOptions = {}
): QuotaResponse | null {
  const [quota, setQuota] = useState<QuotaResponse | null>(null);

  useEffect(() => {
    if (!enabled || !busRef) return;
    let cancelled = false;
    const fetchQuota = () => {
      if (!busRef.current) return;
      busRef.current.emit("quota:get", {}, (res: any) => {
        if (!cancelled && res?.success && res.providers) setQuota(res);
      });
    };
    fetchQuota();
    const stop = pollWhileVisible(fetchQuota, QUOTA_POLL_MS);
    return () => { cancelled = true; stop(); };
  }, [busRef, enabled]);

  return quota;
}
