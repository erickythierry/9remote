// Quota tracker socket handlers — one aggregate `quota:get` request returning
// every provider. TTL-cached and in-flight-deduped so multiple connected
// clients polling at once cost one fetch round.
import { QUOTA_TTL_MS } from "./constants.js";
import { fetchClaudeQuota } from "./fetchers/claudeFetcher.js";
import { fetchCodexQuota } from "./fetchers/codexFetcher.js";
import { fetchKimiQuota } from "./fetchers/kimiFetcher.js";
import { fetchGrokQuota } from "./fetchers/grokFetcher.js";
import type { QuotaResult } from "./lib/quotaWindow.js";

type Providers = Record<string, QuotaResult>;
type QuotaReply = { success: true; providers: Providers; cachedAt: number } | { success: false; error: string };

const FETCHERS: Record<string, () => Promise<QuotaResult>> = {
  claude: fetchClaudeQuota,
  codex: fetchCodexQuota,
  kimi: fetchKimiQuota,
  grok: fetchGrokQuota
};

let cache: { ts: number; result: Providers | null; pending: Promise<Providers> | null } = { ts: 0, result: null, pending: null };

// Thrown values are unknown; only a string `message` property is used.
function errorMessageOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("message" in e)) return undefined;
  return typeof e.message === "string" ? e.message : undefined;
}

async function fetchAll(): Promise<Providers> {
  const entries = await Promise.all(Object.entries(FETCHERS).map(async ([provider, fetcher]): Promise<[string, QuotaResult]> => {
    try {
      return [provider, await fetcher()];
    } catch (e) {
      return [provider, { provider, session: null, weekly: null, monthly: null, buckets: null, updatedAt: Date.now(), error: errorMessageOf(e) || String(e), status: "error" }];
    }
  }));
  return Object.fromEntries(entries);
}

// Narrow view of the socket this feature uses; satisfied by socket.io Socket and HostBus.
export interface QuotaSocket {
  on<A extends unknown[]>(event: string, handler: (...args: A) => unknown): unknown;
}

export function setupQuotaTrackerHandlers(socket: QuotaSocket): void {
  socket.on("quota:get", async (_payload: unknown, callback?: (reply: QuotaReply) => void) => {
    const now = Date.now();
    if (cache.result && now - cache.ts < QUOTA_TTL_MS) {
      return callback?.({ success: true, providers: cache.result, cachedAt: cache.ts });
    }
    if (!cache.pending) {
      cache.pending = fetchAll()
        .then((result) => { cache = { ts: Date.now(), result, pending: null }; return result; })
        .catch(() => { cache.pending = null; return {}; });
    }
    try {
      const providers = await cache.pending;
      callback?.({ success: true, providers, cachedAt: cache.ts });
    } catch (e) {
      callback?.({ success: false, error: errorMessageOf(e) || "quota fetch failed" });
    }
  });
}
