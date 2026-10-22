// Jev decision client — native systemone protocol (state + choice questions in,
// answers with calibrated probabilities out). Presets mirror voice-input config.
import crypto from "node:crypto";
import { readSettings } from "../../lib/settings.js";
import {
  JEV_HTTP_TIMEOUT_MS, JEV_PRESETS, JEV_RETRY_429_MS, OPENCODE_SYSTEMONE_UA
} from "./constants.js";


// Upstream session-id shapes: ses_/msg_ + 12 hex + 14 base62 (same recipe as opencodeStt).
function opencodeId(prefix: string): string {
  const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const random = Array.from(crypto.randomBytes(14), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}${random}`;
}

export interface JevConfig {
  preset?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
}

export interface JevDecision {
  state: unknown;
  questions: unknown;
}

export interface JevAnswer {
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

// Resolve user config into a concrete {url, model, headers} for one request.
export type ResolvedJev = { error: string } | { url: string; model: string; headers: Record<string, string> };

export function resolveJevConfig(config: JevConfig = {}): ResolvedJev {
  const preset = JEV_PRESETS[(config.preset ?? "") as keyof typeof JEV_PRESETS] || JEV_PRESETS.free;
  const endpoint = (config.endpoint || preset.endpoint || "").trim();
  const model = (config.model || preset.model || "").trim();
  if (!endpoint) return { error: "No systemone endpoint configured" };
  if (!model) return { error: "No model configured" };
  const url = endpoint.endsWith("/systemone") ? endpoint : `${endpoint.replace(/\/$/, "")}/systemone`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.preset === "free" || endpoint.includes("opencode.ai")) {
    // Free lane gate: look like the opencode desktop client (recipe verified live).
    Object.assign(headers, {
      "Authorization": "Bearer public",
      "User-Agent": OPENCODE_SYSTEMONE_UA,
      "x-opencode-client": "desktop",
      "x-opencode-session": opencodeId("ses"),
      "x-opencode-request": opencodeId("msg"),
      "x-opencode-project": "global"
    });
  } else if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  } else if (readSettings().voiceConfig?.openrouterKey) {
    // One paste for both features: fall back to the voice-input OpenRouter key.
    headers["Authorization"] = `Bearer ${readSettings().voiceConfig?.openrouterKey}`;
  } else if (endpoint.includes("openrouter.ai")) {
    // Calling OpenRouter without auth yields a cryptic "No cookie auth
    // credentials found" — fail here with an actionable message instead.
    return { error: "OpenRouter preset needs an API key — set it in settings" };
  }
  return { url, model, headers };
}

// Upstream contract: probabilities cover exactly the offered ids, sum to ~1 and the
// choice is the max — anything else is refused before any action runs.
// `answer` is provider JSON: validated at runtime here, not trusted by type.
export function validateChoice(answer: unknown, ids: string[]): JevAnswer | null {
  try {
    const a = answer as JevAnswer;
    const probabilities = a.probabilities as Record<string, number>;
    const numbers: unknown[] = [...Object.values(probabilities), a.confidence];
    const sameKeySet = Object.keys(probabilities).length === ids.length &&
      ids.every((id) => id in probabilities);
    const valid =
      ids.includes(a.choice) &&
      sameKeySet &&
      numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
      Math.abs(Object.values(probabilities).reduce((x: number, y: number) => x + y, 0) - 1) < 0.02 &&
      probabilities[a.choice] >= Math.max(...Object.values(probabilities)) - 1e-6;
    return valid ? a : null;
  } catch {
    return null;
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JEV_HTTP_TIMEOUT_MS)
      });
    } catch (e) {
      throw new Error(`Jev connection failed: ${(e as Error).message}`);
    }
    if ([429, 503, 529].includes(res.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, JEV_RETRY_429_MS * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: { message?: string }; message?: string } | null;
        detail = data?.error?.message || data?.message || detail;
      } catch { /* keep status-line detail */ }
      throw new Error(`Jev provider error: ${detail}`);
    }
    return await res.json();
  }
  throw new Error("Jev provider unavailable");
}

// One decision: {state, questions} -> validated answers keyed by question name.
export async function decide({ state, questions }: JevDecision, config: JevConfig): Promise<{ answers: Record<string, unknown>; model: string; usage: unknown }> {
  const resolved = resolveJevConfig(config);
  if ('error' in resolved) throw new Error(resolved.error);
  const result = await postJson(resolved.url, resolved.headers, { model: resolved.model, state, questions });
  const body = result as { answers?: Record<string, unknown>; model?: string; usage?: unknown } | null;
  const answers = body?.answers;
  if (!answers || typeof answers !== "object") throw new Error("Jev returned no answers");
  return { answers, model: body?.model || resolved.model, usage: body?.usage || {} };
}

// Settings "Test" button: one tiny choice call, no browser involved.
export async function testConfig(config: JevConfig): Promise<{ ok: true; model: string; choice: string; latencyMs: number }> {
  const started = Date.now();
  const result = await decide({
    state: { page: { url: "https://example.com", title: "Test", text: "test" }, elements: [], recent_actions: [] },
    questions: {
      operation: {
        type: "choice",
        criteria: { DONE: "Nothing to do", BLOCKED: "Cannot progress" },
        instructions: { goal: "connectivity test", rules: "pick one" }
      }
    }
  }, config);
  const answer = validateChoice(result.answers.operation, ["DONE", "BLOCKED"]);
  if (!answer) throw new Error("Jev response failed validation");
  return { ok: true, model: result.model, choice: answer.choice, latencyMs: Date.now() - started };
}
