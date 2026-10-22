import os from "os";
import { SERVER_PORT, STEP } from "../../lib/constants.js";
import { renderProgress, updateProgressDesc } from "../utils/tui.js";

// Dev override: point the CLI at a dev/local server without touching the
// production one that holds the default port.
const API_PORT = Number(process.env.NREMOTE_LOCAL_API_PORT) || SERVER_PORT;

let isTuiActive = false;
export function setTuiActive(v: boolean) { isTuiActive = v; }

// Probe both families in parallel (Ubuntu/glibc may resolve localhost → ::1 first),
// prefer localhost when both live, cache winner. Reset on failure so we retry next call.
let cachedHost: string | null = null;
export async function resolveLocalHost(): Promise<string> {
  if (cachedHost) return cachedHost;
  const probe = (h: string) =>
    fetch(`http://${h}:${API_PORT}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? h : Promise.reject()));
  const results = await Promise.allSettled(["localhost", "127.0.0.1"].map(probe));
  const live = results.map((r, i) => (r.status === "fulfilled" ? ["localhost", "127.0.0.1"][i] : null));
  cachedHost = live.find((h) => h === "localhost") || live.find(Boolean) || null;
  return cachedHost || "127.0.0.1";
}

function bumpHostOnFail() { cachedHost = null; }

export async function apiPost(path: string, data?: unknown): Promise<Response | null> {
  const host = await resolveLocalHost();
  try {
    return await fetch(`http://${host}:${API_PORT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { bumpHostOnFail(); return null; }
}

export async function apiGet<T extends object = Record<string, unknown>>(path: string): Promise<T | null> {
  const host = await resolveLocalHost();
  try {
    const res = await fetch(`http://${host}:${API_PORT}${path}`);
    return res.ok ? await res.json() as T : null;
  } catch { bumpHostOnFail(); return null; }
}

export async function pushUiState(data: Record<string, unknown>) {
  await apiPost("/api/ui/state", data);
}

export async function setStep(step: number, extra: Record<string, unknown> = {}) {
  if (isTuiActive) renderProgress(step - 1, step > STEP.PREPARING);
  await pushUiState({ step, stepDesc: "", ...extra });
}

export function onBinaryProgress({ phase, percent }: { phase: "download" | "extract"; percent?: number }) {
  const text = phase === "download"
    ? `Downloading tunnel binary ${percent ?? 0}%`
    : "Extracting tunnel binary";
  if (isTuiActive) updateProgressDesc(text);
  pushUiState({ stepDesc: text });
}

export async function isServerRunning() {
  return !!(await apiGet("/api/health"));
}

export async function fetchServerState() {
  const [d, a, s, si] = await Promise.all([
    apiGet<{ desktopEnabled?: boolean; remoteAvailable?: boolean }>("/api/ui/state"),
    apiGet<{ enabled?: boolean }>("/api/device/auto-approve"),
    apiGet<{ enabled?: boolean }>("/api/autostart"),
    apiGet<{ mode?: string; active?: boolean; presets?: unknown[] }>("/api/sleep-inhibit"),
  ]);
  return {
    desktopEnabled: !!d?.desktopEnabled,
    remoteAvailable: !!d?.remoteAvailable,
    autoApprove: !!a?.enabled,
    autoStart: !!s?.enabled,
    sleepInhibitMode: si?.mode || "never",
    sleepInhibitActive: !!si?.active,
    sleepInhibitPresets: Array.isArray(si?.presets) ? si.presets : [],
  };
}

export function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}
