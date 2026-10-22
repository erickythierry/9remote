import dns from "dns";
import { execFile } from "child_process";
import { browserFetch } from "../../lib/constants.js";

const PROBE_DNS_TIMEOUT_MS = 2000;
const PROBE_FETCH_TIMEOUT_MS = 5000;

const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);

// Win DNS negative cache holds ENOTFOUND past Cloudflare publish — flush so query hits upstream
export function flushWinDns() {
  if (process.platform !== "win32") return;
  execFile("ipconfig", ["/flushdns"], { windowsHide: true }, () => {});
}

export async function resolveTunnelDns(hostname: string, timeoutMs = PROBE_DNS_TIMEOUT_MS): Promise<
  { ok: true; addrs: string[]; elapsedMs: number } | { ok: false; code: string; elapsedMs: number }
> {
  const t0 = Date.now();
  try {
    const queryDual = async (): Promise<string[]> => {
      const [res4, res6] = await Promise.allSettled([
        dnsResolver.resolve4(hostname),
        dnsResolver.resolve6(hostname),
      ]);
      if (res4.status === "fulfilled" && res4.value?.length) return res4.value;
      if (res6.status === "fulfilled" && res6.value?.length) return res6.value;
      const error4 = res4.status === "rejected" ? res4.reason : undefined;
      const error6 = res6.status === "rejected" ? res6.reason : undefined;
      throw error4 || error6 || Object.assign(new Error("DNS query failed"), { code: "ENOTFOUND" });
    };

    const addrs = await Promise.race([
      queryDual(),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" })), timeoutMs)
      ),
    ]);
    return { ok: true, addrs, elapsedMs: Date.now() - t0 };
  } catch (err) {
    const error = err as { code?: string; message?: string };
    return { ok: false, code: error.code || error.message || "unknown", elapsedMs: Date.now() - t0 };
  }
}

/**
 * Single tunnel-health probe: DNS resolve via 1.1.1.1 → fetch /api/health.
 * Returns { ok, dnsCode?, httpStatus?, elapsedMs }.
 */
export async function probeTunnelOnce(url: string, { flushDns = false }: { flushDns?: boolean } = {}): Promise<
  { ok: boolean; dnsCode?: string; httpStatus?: number; elapsedMs: number }
> {
  const t0 = Date.now();
  let hostname: string | null = null;
  try { hostname = new URL(url).hostname; } catch {}

  if (flushDns) flushWinDns();

  if (hostname) {
    const dnsRes = await resolveTunnelDns(hostname);
    if (!dnsRes.ok) {
      flushWinDns();
      return { ok: false, dnsCode: dnsRes.code, elapsedMs: Date.now() - t0 };
    }
  }

  try {
    const res = await browserFetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS),
    });
    return { ok: res.ok, httpStatus: res.status, elapsedMs: Date.now() - t0 };
  } catch (err) {
    const error = err as { cause?: { code?: string }; code?: string; message?: string };
    return { ok: false, dnsCode: error.cause?.code || error.code || error.message, elapsedMs: Date.now() - t0 };
  }
}
