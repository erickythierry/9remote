// Config-driven logger for remote feature — routes through centralized logger.
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";
import { createLogger } from "../../../lib/logger.js";

const cfg = () => REMOTE_CONFIG.logging;
const logger = createLogger("remote");

export const remoteLog = {
  lifecycle: (msg: string) => { if (cfg().lifecycle) logger.info(msg); },
  focus: (msg: string) => { if (cfg().focus) logger.info(msg); },
  dpi: (msg: string) => { if (cfg().dpiDetection) logger.info(msg); },
  stats: (msg: string) => { if (cfg().resizeStats) logger.info(msg); },
  error: (msg: string, err?: any) => { if (cfg().errors) logger.error(`${msg} ${err?.message || err || ""}`); },
  warn: (msg: string) => { if (cfg().errors) logger.warn(msg); },
};
