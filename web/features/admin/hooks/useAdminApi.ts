"use client";

import { useCallback } from "react";

async function request<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...((options.headers as Record<string, string>) || {}) },
    credentials: "include"
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function useAdminApi() {
  const get = useCallback(<T = any>(url: string) => request<T>(url), []);
  const post = useCallback(<T = any>(url: string, body?: unknown) => request<T>(url, { method: "POST", body: JSON.stringify(body || {}) }), []);
  const patch = useCallback(<T = any>(url: string, body?: unknown) => request<T>(url, { method: "PATCH", body: JSON.stringify(body || {}) }), []);
  const del = useCallback(<T = any>(url: string) => request<T>(url), []);
  return { get, post, patch, del };
}
