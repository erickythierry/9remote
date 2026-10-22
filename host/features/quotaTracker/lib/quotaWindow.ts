// Shared shape helpers for quota windows. A window is
// { usedPercent, windowMinutes, resetsAt } — resetsAt in Unix ms, null if unknown.
import { readFile } from "node:fs/promises";

export type QuotaWindow = { usedPercent: number; windowMinutes: number; resetsAt: number | null };
export type QuotaStatus = "ok" | "error" | "unavailable";
export type QuotaResult = {
  provider: string;
  session: QuotaWindow | null;
  weekly: QuotaWindow | null;
  monthly: QuotaWindow | null;
  buckets: unknown;
  updatedAt: number;
  error: string | null;
  status: QuotaStatus;
};

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

// 1e10 separates any seconds epoch (<2286) from any ms epoch (>2001).
export function parseResetTimestamp(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(num) && String(value).trim() !== "") {
    return num > 10_000_000_000 ? num : num * 1000;
  }
  const parsed = new Date(value as string | number).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function makeResult(
  provider: string,
  status: QuotaStatus,
  error: string | null = null,
  windows: Partial<Pick<QuotaResult, "session" | "weekly" | "monthly" | "buckets">> = {}
): QuotaResult {
  return {
    provider,
    session: windows.session ?? null,
    weekly: windows.weekly ?? null,
    monthly: windows.monthly ?? null,
    buckets: windows.buckets ?? null,
    updatedAt: Date.now(),
    error,
    status
  };
}

// Response body is external input: typed unknown, each fetcher narrows it.
export async function fetchJson(url: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
  const { timeoutMs, ...init } = options;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 10_000), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Read + JSON.parse a credential file; null when missing (ENOENT) — caller decides
// whether that means "signed out" vs "error".
export async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}
