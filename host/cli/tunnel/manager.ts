import { spawnQuickTunnel, killCloudflared, hasLiveTunnel } from "../utils/cloudflared.js";
import { computeDelay, retryForever } from "../utils/backoff.js";
import { RETRY_CONFIG } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("tunnel");

type TunnelResult = { child: ChildProcess; tunnelUrl: string };
type RetryNotice = { attempt: number; delay: number };
type TunnelCallbacks = {
  onUrlUpdate: (url: string) => unknown;
  onRestart?: (port: number | string) => unknown;
  onRetry?: (notice: RetryNotice) => unknown;
};

export async function spawnQuickTunnelWithRetry(localPort: number, onUrlUpdate: (url: string) => unknown, onRestart: ((port: number | string) => unknown) | null, onRetry?: (notice: RetryNotice) => unknown): Promise<TunnelResult> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await spawnQuickTunnel(localPort, onUrlUpdate, onRestart);
    } catch (err) {
      const delay = computeDelay(RETRY_CONFIG.tunnelSpawn, attempt);
      logger.warn(`spawn attempt ${attempt} failed: ${(err as { message?: string } | null)?.message || err} — retry in ${delay}ms`);
      onRetry?.({ attempt, delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// First spawn registers this restart handler in cloudflared.js; subsequent restarts reuse it
export function makeTunnelRestartHandler({ onUrlUpdate, setTunnel, onRetry }: {
  onUrlUpdate: (url: string) => unknown;
  setTunnel: (child: ChildProcess) => unknown;
  onRetry?: (notice: RetryNotice) => unknown;
}) {
  return async (port: number | string): Promise<void> => {
    try {
      const r = await spawnQuickTunnelWithRetry(port as number, onUrlUpdate, null, onRetry);
      // A background reconnect loop may still be waiting out its backoff from an
      // earlier failure. It has no way to notice this tunnel, so on its next wake
      // it spawns another cloudflared, whose startup kills the stale pid — which
      // is the tunnel serving traffic right now. Cancel it: the restart succeeded,
      // so there is nothing left for that loop to recover.
      cancelActiveBgTunnel();
      setTunnel(r.child);
      await onUrlUpdate(r.tunnelUrl);
      logger.info(`Tunnel restarted: ${r.tunnelUrl}`);
    } catch (err) {
      logger.error(`Tunnel restart failed: ${(err as { message?: string } | null)?.message || err}`);
    }
  };
}

// Background reconnect after foreground spawn failed or health-timed-out.
// Never gives up; backoff in minutes to avoid spamming trycloudflare rate limits.
// Singleton ctx so any mode's stop/shutdown can cancel the active loop.
let activeBgCtx: { cancelled: boolean } | null = null;
export function cancelActiveBgTunnel() {
  if (activeBgCtx) { activeBgCtx.cancelled = true; activeBgCtx = null; }
}
export function startBackgroundTunnelReconnect(localPort: number, { onUrlUpdate, onRestart, setActiveTunnel, onReady }: {
  onUrlUpdate: (url: string) => unknown;
  onRestart?: (port: number | string) => unknown;
  setActiveTunnel?: (child: ChildProcess) => unknown;
  onReady?: (result: TunnelResult) => unknown;
}) {
  cancelActiveBgTunnel(); // supersede any lingering loop from a previous start
  const ctx = { cancelled: false };
  activeBgCtx = ctx;
  retryForever({
    config: RETRY_CONFIG.tunnelRateLimit,
    task: async () => {
      if (ctx.cancelled) return true;
      // Another path may have brought a tunnel up while this loop sat in its
      // backoff. Spawning now would kill it during startup's stale-pid cleanup,
      // taking down a working tunnel to replace it with an identical one.
      if (hasLiveTunnel()) {
        logger.info("bg-tunnel: a tunnel is already live — standing down");
        return true;
      }
      const r = await spawnQuickTunnel(localPort, onUrlUpdate, onRestart);
      // Spawn resolved after cancel — clean up the orphan, skip side effects
      if (ctx.cancelled) { try { killCloudflared(); } catch {} return true; }
      // Decouple side effects from spawn success — a failure here (e.g. Worker
      // sync) must not make retryForever respawn an already-up tunnel.
      try {
        setActiveTunnel?.(r.child);
        await onUrlUpdate?.(r.tunnelUrl);
        await onReady?.(r);
        logger.info(`bg tunnel up: ${r.tunnelUrl}`);
      } catch (err) {
        logger.error(`bg tunnel post-spawn failed: ${(err as { message?: string } | null)?.message || err}`);
      }
      return true; // success → stop the loop
    },
    label: "bg-tunnel",
    log: (m) => logger.info(m),
    ctx,
  });
  return ctx;
}
import type { ChildProcess } from "child_process";
