// Grok CLI quota: reads the session file the CLI maintains (~/.grok/auth.json),
// then GET the billing endpoint. Weekly credits first; unified-billing accounts
// fall back to the monthly included-budget view.
import { join } from "node:path";
import { homedir } from "node:os";
import {
  API_TIMEOUT_MS,
  GROK_AUTH_HEADER,
  GROK_BILLING_CREDITS_URL,
  GROK_BILLING_DEFAULT_URL,
  MONTHLY_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES
} from "../constants.js";
import { clampPercent, fetchJson, makeResult, readJsonFile } from "../lib/quotaWindow.js";
import type { QuotaWindow } from "../lib/quotaWindow.js";
import { errorMessage } from "../../../lib/errorMessage.js";

type GrokSession = { key: string; user_id?: unknown; expires_at?: unknown };
// Billing payload fields are untrusted; each mapper narrows the value it reads.
type GrokConfig = Record<string, unknown>;

const authPath = (): string => join(process.env.GROK_HOME || join(homedir(), ".grok"), "auth.json");

function parseMoneyVal(value: unknown): number | null {
  const raw = (value as { val?: unknown } | null | undefined)?.val;
  const num = typeof raw === "string" ? parseFloat(raw) : raw;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

function mapPeriodEnd(config: GrokConfig): number | null {
  const period = config.currentPeriod as { end?: unknown } | undefined;
  const end = period?.end ?? config.billingPeriodEnd;
  const ms = end ? Date.parse(String(end)) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function mapWeeklyCredits(config: GrokConfig): QuotaWindow | null {
  if (typeof config.creditUsagePercent !== "number") return null;
  return {
    usedPercent: clampPercent(config.creditUsagePercent),
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: mapPeriodEnd(config)
  };
}

function mapMonthlyUsage(config: GrokConfig): QuotaWindow | null {
  const limit = parseMoneyVal(config.monthlyLimit);
  const used = parseMoneyVal(config.used);
  if (limit === null || used === null || limit <= 0) return null;
  return {
    usedPercent: clampPercent((used / limit) * 100),
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    resetsAt: mapPeriodEnd(config)
  };
}

function requestHeaders(session: GrokSession): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.key}`,
    "X-XAI-Token-Auth": GROK_AUTH_HEADER,
    Accept: "application/json"
  };
  if (session.user_id) headers["x-userid"] = String(session.user_id);
  return headers;
}

// auth.json maps issuer key → session entry. The default xAI issuer wins when
// fresh; alternate issuers are compatibility fallbacks only when it's absent.
function pickSession(auth: unknown): GrokSession | null {
  if (!auth || typeof auth !== "object") return null;
  const PREFERRED = "https://auth.x.ai";
  let expiredPreferred: GrokSession | null = null;
  let fallback: GrokSession | null = null;
  let preferredSeen = false;
  for (const [issuer, rawEntry] of Object.entries(auth)) {
    const entry = rawEntry as GrokSession | null;
    const isPreferred = issuer === PREFERRED || issuer.startsWith(`${PREFERRED}::`);
    preferredSeen ||= isPreferred;
    if (typeof entry?.key !== "string" || !entry.key) continue;
    // Missing expiry stays usable — a bad token surfaces as billing HTTP 401.
    const expiresMs = entry.expires_at ? Date.parse(String(entry.expires_at)) : null;
    const fresh = !Number.isFinite(expiresMs) || (expiresMs as number) - Date.now() > 5000;
    if (isPreferred) {
      if (fresh) return entry;
      expiredPreferred ??= entry;
    } else {
      fallback ??= entry;
    }
  }
  return expiredPreferred ?? (preferredSeen ? null : fallback);
}

export async function fetchGrokQuota() {
  const auth = await readJsonFile(authPath());
  const session = pickSession(auth);
  if (!session) return makeResult("grok", "unavailable", "Not signed in to Grok CLI");

  try {
    let data = await fetchJson(GROK_BILLING_CREDITS_URL, {
      headers: requestHeaders(session),
      timeoutMs: API_TIMEOUT_MS
    }) as { config?: GrokConfig } & GrokConfig | null;
    const config = data?.config ?? data ?? null;

    const weekly = config && mapWeeklyCredits(config);
    if (weekly) return makeResult("grok", "ok", null, { weekly });

    // Unified-billing accounts omit creditUsagePercent — the default view has the monthly budget.
    if (config) {
      const monthly = mapMonthlyUsage(config);
      if (monthly) return makeResult("grok", "ok", null, { monthly });
      data = await fetchJson(GROK_BILLING_DEFAULT_URL, {
        headers: requestHeaders(session),
        timeoutMs: API_TIMEOUT_MS
      }) as { config?: GrokConfig } & GrokConfig | null;
      const fallbackConfig = data?.config ?? data ?? null;
      const fallbackMonthly = fallbackConfig && mapMonthlyUsage(fallbackConfig);
      if (fallbackMonthly) return makeResult("grok", "ok", null, { monthly: fallbackMonthly });
    }
    return makeResult("grok", "unavailable", "Grok billing response did not include usage");
  } catch (e) {
    return makeResult("grok", "error", errorMessage(e));
  }
}
