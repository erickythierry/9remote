import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

export function debugLog(flag: keyof typeof REMOTE_CONFIG.debug | "auth", ...args: unknown[]): void {
  if (flag !== "auth" && REMOTE_CONFIG.debug?.[flag]) console.log(...args);
}
