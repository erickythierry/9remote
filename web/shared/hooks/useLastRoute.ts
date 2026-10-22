"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";

const PREFIX = "9remote_nav:";

// Build full URL (path + query) from Next router primitives
function buildUrl(pathname: string | null, searchParams: ReadonlyURLSearchParams | null): string {
  if (!pathname) return "";
  const qs = searchParams?.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export const saveLastRoute = (apiKey: string | null | undefined, url: string | null | undefined): void => {
  if (typeof window === "undefined" || !apiKey || !url) return;
  try { localStorage.setItem(PREFIX + apiKey, url); } catch {}
};

export const getLastRoute = (apiKey: string | null | undefined): string | null => {
  if (typeof window === "undefined" || !apiKey) return null;
  try { return localStorage.getItem(PREFIX + apiKey); } catch { return null; }
};

export const clearLastRoute = (apiKey: string | null | undefined): void => {
  if (typeof window === "undefined" || !apiKey) return;
  try { localStorage.removeItem(PREFIX + apiKey); } catch {}
};

/**
 * Persists the current workspace URL under the given apiKey on every route change.
 * Only tracks routes under /workspace — login/admin are not session state to restore.
 */
export function useLastRoute(apiKey: string | null | undefined): void {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!apiKey || !pathname?.startsWith("/workspace")) return;
    const url = buildUrl(pathname, searchParams);
    if (url) saveLastRoute(apiKey, url);
  }, [apiKey, pathname, searchParams]);
}
