// Claude Code quota (Pro/Max OAuth): token from ~/.claude/.credentials.json or
// macOS Keychain, then GET the OAuth usage endpoint. API-key billing has no
// subscription quota — surfaces as "unavailable" so the web segment hides.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_OAUTH_USAGE_URL,
  CLAUDE_USER_AGENT,
  SESSION_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES
} from "../constants.js";
import { clampPercent, fetchJson, makeResult, parseResetTimestamp, readJsonFile } from "../lib/quotaWindow.js";
import type { QuotaWindow } from "../lib/quotaWindow.js";
import { errorMessage } from "../../../lib/errorMessage.js";

const execFileAsync = promisify(execFile);

// Only the field the fetcher reads; the credentials file holds more.
type ClaudeOAuth = { accessToken?: unknown };

function credentialsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
}

// Keychain item holds the same JSON as the credentials file. Windows/Linux
// Claude Code always writes the file, so keychain is macOS-only.
async function readKeychainOAuth(): Promise<ClaudeOAuth | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"
    ]);
    return (JSON.parse(stdout) as { claudeAiOauth?: ClaudeOAuth } | null)?.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

// Returns { token, hasCredentials } — credentials present with an empty access
// token means the CLI must refresh them first (we don't run `claude` for that).
async function readOAuth(): Promise<{ token: string | null; hasCredentials: boolean }> {
  const fileData = (await readJsonFile(credentialsPath())) as { claudeAiOauth?: ClaudeOAuth } | null;
  const oauth = fileData?.claudeAiOauth ?? await readKeychainOAuth();
  const token = oauth?.accessToken;
  if (typeof token === "string" && token) return { token, hasCredentials: true };
  return { token: null, hasCredentials: Boolean(oauth) };
}

function mapWindow(raw: unknown, windowMinutes: number): QuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const window = raw as { utilization?: unknown; used_percentage?: unknown; resets_at?: unknown };
  const used = typeof window.utilization === "number" ? window.utilization : window.used_percentage;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return {
    usedPercent: clampPercent(used),
    windowMinutes,
    resetsAt: parseResetTimestamp(window.resets_at)
  };
}

export async function fetchClaudeQuota() {
  const { token, hasCredentials } = await readOAuth();
  if (!token) {
    return hasCredentials
      ? makeResult("claude", "error", "Claude credentials need refresh — run claude once")
      : makeResult("claude", "unavailable", "Not signed in to Claude Code");
  }

  try {
    const data = await fetchJson(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
        "User-Agent": CLAUDE_USER_AGENT
      }
    }) as { five_hour?: unknown; seven_day?: unknown };
    return makeResult("claude", "ok", null, {
      session: mapWindow(data.five_hour, SESSION_WINDOW_MINUTES),
      weekly: mapWindow(data.seven_day, WEEKLY_WINDOW_MINUTES)
    });
  } catch (e) {
    return makeResult("claude", "error", errorMessage(e));
  }
}
