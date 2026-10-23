// Model options discovered dynamically from CLI configurations and local catalogs.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PATHS } from "../../lib/constants.js";
import { writeJsonAtomic } from "../../lib/atomicFile.js";
import { getExtendedEnv } from "./adapters/env.js";
import { AI_MODEL_CACHE_TTL_MS } from "./constants.js";
import { probeLauncher } from "./launcherProbe.js";
import { claudeConfigDir } from "./claudeProfile.js";

const require = createRequire(import.meta.url);

export interface ModelOption {
  id: string;
  label: string;
  short?: string;
  desc?: string;
  provider?: string;
  efforts?: string[];
  defaultEffort?: string;
  contextWindow?: number;
  recent?: boolean;
  recentRank?: number;
}

// Env slots for Claude models; [1m] context suffix is preserved.
const SLOTS: [string, string][] = [
  ["ANTHROPIC_CUSTOM_MODEL_OPTION", "Custom"],
  ["ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable"],
  ["ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"],
  ["ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"],
  ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"],
];

// Fallback aliases when no custom models are configured.
const FALLBACK: ModelOption[] = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
];

const CODEX_CATALOG_TIMEOUT_MS = 5000;
const OPENCODE_CATALOG_TIMEOUT_MS = 10000;

function readClaudeSettings(launcher: string = ""): Record<string, any> {
  try {
    const file = path.join(claudeConfigDir(launcher), "settings.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// What claude will see: the launcher's own env and --settings win over <config dir>/settings.json.
function claudeConfigFor(launcher: string): { env: Record<string, any>; picker: any[]; model?: string } {
  const base = readClaudeSettings(launcher);
  const probe = probeLauncher(launcher);
  if (!probe) return { env: base.env || {}, picker: [], model: base.model };
  return {
    env: { ...(base.env || {}), ...probe.env },
    picker: probe.settings.modelPicker?.options || [],
    model: probe.settings.model || base.model
  };
}

export function listModelOptions(launcher: string = ""): ModelOption[] {
  const { env, picker } = claudeConfigFor(launcher);
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, label: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    options.push({ id, label, short: id });
  };
  for (const [key, label] of SLOTS) {
    push(typeof env[key] === "string" ? env[key].trim() : "", label);
  }
  if (options[0]?.label === "Custom" && typeof env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME === "string") {
    options[0].label = env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME.trim() || "Custom";
  }
  for (const o of picker) push(typeof o?.model === "string" ? o.model.trim() : "", o.label || o.model);

  return options.length > 0 ? options : FALLBACK;
}

const FALLBACK_CODEX_MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", short: "5.6 Sol", provider: "openai", desc: "Flagship reasoning model for complex engineering" },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", short: "5.6 Terra", provider: "openai", desc: "High-throughput balanced model" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", short: "5.6 Luna", provider: "openai", desc: "Fast, lightweight reasoning model" },
  { id: "gpt-5.5", label: "GPT-5.5", short: "5.5", provider: "openai", desc: "Advanced reasoning and coding model" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex", short: "5.3 Codex", provider: "openai", desc: "Specialized code generation & editing model" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1-Codex-Max", short: "5.1 Max", provider: "openai", desc: "Large-context deep reasoning model" },
  { id: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex-Mini", short: "5.1 Mini", provider: "openai", desc: "Fast, cost-effective coding model" },
  { id: "gpt-6-astra", label: "GPT-6-Astra", short: "6 Astra", provider: "openai", desc: "Our most capable model for complex, demanding work" },
];

// Read custom profiles from ~/.codex/*.config.toml and ~/.codex/config.toml
function readCodexProfiles(): ModelOption[] {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const options: ModelOption[] = [];
  const seenIds = new Set<string>();

  // 1. Standalone profile files ~/.codex/<name>.config.toml
  try {
    const files = fs.readdirSync(codexHome);
    for (const f of files) {
      if (f.endsWith(".config.toml") && f !== "config.toml") {
        const name = f.replace(/\.config\.toml$/, "");
        try {
          const text = fs.readFileSync(path.join(codexHome, f), "utf8");
          const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(text)?.[1] || "";
          const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(text)?.[1] || "";
          const id = model || name;
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            options.push({
              id,
              label: id,
              short: id,
              desc: `Profile: ${name}`,
              provider: "profiles",
              efforts: effort ? [effort] : [],
              defaultEffort: effort || ""
            });
          }
        } catch {}
      }
    }
  } catch {}

  // 2. Default model and in-file profiles from ~/.codex/config.toml
  try {
    const text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const sections = text.split(/^\s*\[/m);
    const top = sections[0] || "";
    const topModel = /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
    const topEffort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
    if (topModel && !seenIds.has(topModel)) {
      seenIds.add(topModel);
      options.push({
        id: topModel,
        label: topModel,
        short: topModel,
        desc: "Default in ~/.codex/config.toml",
        provider: "profiles",
        efforts: topEffort ? [topEffort] : [],
        defaultEffort: topEffort
      });
    }

    for (const section of sections.slice(1)) {
      const header = (section.slice(0, section.indexOf("]")) || "").trim();
      const profileMatch = /^profiles\.([^.\]]+)$/.exec(header);
      if (profileMatch) {
        const name = profileMatch[1];
        const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(section)?.[1];
        const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(section)?.[1] || "";
        const id = model || name;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          options.push({
            id,
            label: id,
            short: id,
            desc: `Profile: ${name}`,
            provider: "profiles",
            efforts: effort ? [effort] : [],
            defaultEffort: effort
          });
        }
      }
    }
  } catch {}

  return options;
}

// List Codex model options: custom profiles on top, followed by official OpenAI models.
export function listCodexModelOptions(): ModelOption[] {
  const profileOptions = readCodexProfiles();
  const seenIds = new Set(profileOptions.map((o) => o.id));

  let liveModels: any[] = [];
  try {
    const res = spawnSync("codex", ["debug", "models"], {
      encoding: "utf8",
      timeout: CODEX_CATALOG_TIMEOUT_MS
    });
    if (!res.error && res.status === 0) {
      liveModels = JSON.parse(res.stdout || "{}").models || [];
    }
  } catch {}

  const officialModels: ModelOption[] = [];
  if (liveModels.length > 0) {
    for (const m of liveModels) {
      if (!m?.slug || m.visibility !== "list") continue;
      officialModels.push({
        id: m.slug,
        label: m.display_name || m.slug,
        short: m.display_name || m.slug,
        desc: m.description || "",
        provider: "openai",
        defaultEffort: m.default_reasoning_level || "",
        efforts: (m.supported_reasoning_levels || []).map((r: any) => r.effort),
        contextWindow: Math.round((m.context_window || 0) * ((m.effective_context_window_percent ?? 100) / 100)) || 0
      });
    }
  }

  // Fallback only covers a failed/timeout `codex debug models` — the live catalog
  // wins, stale fallback slugs must not ride along.
  if (officialModels.length === 0) officialModels.push(...FALLBACK_CODEX_MODELS);

  const result = [...profileOptions];
  for (const m of officialModels) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      result.push(m);
    }
  }

  return result;
}

// List OpenCode models and supported reasoning variants. OpenCode v2 removed the
// `--verbose` flag and prints a plain provider/model catalog; older versions still
// expose variants as JSON after each id. Keep both formats so the chat UI does not
// silently collapse to the serve API's (sometimes project-scoped) model list.
export function listOpencodeModelOptions(): ModelOption[] {
  let out = "";
  try {
    const res = spawnSync("opencode", ["models", "--verbose"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    // Try the current CLI format below.
  }

  const options: ModelOption[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(id) || lines[i + 1]?.trim() !== "{") continue;
    let json = "", depth = 0;
    for (let j = i + 1; j < lines.length; j++) {
      json += lines[j];
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0) { i = j; break; }
    }
    let model: any = null;
    try {
      model = JSON.parse(json);
    } catch {
    }
    const raw = model?.variants || {};
    options.push({
      id,
      label: id,
      short: id,
      efforts: Object.keys(raw),
      // 'default' is an OpenCode marker, not a reasoning level; fallback to medium.
      defaultEffort: raw.medium ? "medium" : Object.keys(raw).find((k) => k !== "default") || ""
    });
  }

  // OpenCode v2 `models` prints one full model id per line, grouped under
  // provider headings on a TTY. In non-interactive mode (our spawnSync) these
  // are plain ids; accept any non-whitespace suffix so variants like [1m] and
  // (high) survive as part of the model id.
  if (options.length) return options;
  try {
    const res = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const id = line.trim();
    if (!/^[\w.-]+\/[^\s/][^\s]*$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: id, short: id, efforts: [], defaultEffort: "" });
  }
  return options;
}

const AI_PREFERENCES_FILE = path.join(PATHS.STATE, "aiPreferences.json");

export function readAiPreferences(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(AI_PREFERENCES_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

export function saveAiPreference(engine: string, patch: { model?: string; effort?: string } & Record<string, any>) {
  if (!engine || !patch || typeof patch !== "object") return;
  try {
    const current = readAiPreferences();
    const existing = current[engine] || {};
    const cleanModel = patch.model !== undefined
      ? String(patch.model || "").split("\t")[0].trim()
      : undefined;
    const updated = {
      ...existing,
      ...(cleanModel !== undefined ? { model: cleanModel } : null),
      ...(patch.effort !== undefined ? { effort: patch.effort } : null)
    };
    current[engine] = updated;
    writeJsonAtomic(AI_PREFERENCES_FILE, current);
  } catch {}
}

// Resolve default model from preferences or CLI configuration.
// Engine → its model catalog reader; an engine with no entry has no catalog to offer.
const MODEL_LISTERS: Record<string, (launcher?: string) => ModelOption[] | Promise<ModelOption[]> | null> = {
  claude: listModelOptions,
  codex: listCodexModelOptions,
  opencode: listOpencodeModelOptions,
  antigravity: listAntigravityModelOptions,
  omp: listOmpModelOptions,
  pi: listPiModelOptions,
  devin: listDevinModelOptions,
  hermes: listHermesModelOptions
};

export function listModelOptionsFor(engine: string, launcher: string = ""): ModelOption[] | Promise<ModelOption[]> | null {
  return MODEL_LISTERS[engine]?.(launcher) ?? null;
}

// Engine → its own default-model reader; an engine with no entry has no CLI default to read.
let piFirstModel = { at: 0, id: "" };
const DEFAULT_MODEL_READERS: Record<string, (launcher?: string) => string> = {
  claude(launcher = "") {
    const { env, model } = claudeConfigFor(launcher);
    // ANTHROPIC_MODEL outranks settings.json's model in the CLI.
    const alias = (typeof env.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL) || (typeof model === "string" ? model : "");
    if (!alias) return "";
    const slot = SLOTS.find(([, label]) => label.toLowerCase() === alias.toLowerCase());
    return (slot && env[slot[0]]) || alias;
  },
  codex() {
    try {
      const file = path.join(os.homedir(), ".codex", "config.toml");
      const text = fs.readFileSync(file, "utf8");
      const top = text.split(/^\s*\[/m)[0] || "";
      return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
    } catch {
      return "";
    }
  },
  opencode() {
    // Read last used model from OpenCode state file.
    try {
      const file = path.join(os.homedir(), ".local", "state", "opencode", "model.json");
      const recent = JSON.parse(fs.readFileSync(file, "utf8")).recent || [];
      const { providerID, modelID } = recent[0] || {};
      if (!providerID || !modelID) return "";
      const id = `${providerID}/${modelID}`;
      const catalog = listOpencodeModelOptions();
      return catalog.length === 0 || catalog.some((m) => m.id === id) ? id : "";
    } catch {
      return "";
    }
  },
  omp() {
    try {
      const file = path.join(os.homedir(), ".omp", "agent", "config.yml");
      const text = fs.readFileSync(file, "utf8");
      const match = /^\s*default:\s*([^\s\n]+)/m.exec(text);
      if (match?.[1]) return match[1].trim();
    } catch {
      return "";
    }
    return "";
  },
  // pi keeps no default in its config; a fresh session starts on the catalog's
  // first model so the composer and the spawn agree. Cached — the read spawns the CLI.
  pi() {
    const now = Date.now();
    if (piFirstModel.id && now - piFirstModel.at < AI_MODEL_CACHE_TTL_MS) return piFirstModel.id;
    const id = listPiModelOptions()[0]?.id || "";
    if (id) piFirstModel = { at: now, id };
    return id;
  },
  devin() {
    // The CLI's own record: the model its newest session actually ran — never a canned id.
    try {
      const { DatabaseSync } = require("node:sqlite");
      const dbPath = path.join(os.homedir(), ".local", "share", "devin", "cli", "sessions.db");
      if (!fs.existsSync(dbPath)) return "";
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare(
          "SELECT model FROM sessions WHERE model IS NOT NULL AND model != '' ORDER BY last_activity_at DESC LIMIT 1"
        ).get() as { model?: string } | undefined;
        return row?.model || "";
      } finally {
        db.close();
      }
    } catch {
      return "";
    }
  }
};

export function resolveDefaultModel(engine: string, launcher: string = ""): string {
  const saved = readAiPreferences()[engine]?.model;
  if (typeof saved === "string" && saved) return saved.split("\t")[0].trim();
  return DEFAULT_MODEL_READERS[engine]?.(launcher) || "";
}

// Resolve default reasoning effort from preferences or CLI configuration.
// Engine → its own default-effort reader; an engine with no entry has none to read.
const DEFAULT_EFFORT_READERS: Record<string, (launcher?: string) => string> = {
  claude(launcher = "") {
    const level = readClaudeSettings(launcher).effortLevel;
    return typeof level === "string" ? level.trim() : "";
  },
  codex() {
    try {
      const text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
      const top = text.split(/^\s*\[/m)[0] || "";
      return /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
    } catch {
      return "";
    }
  },
  hermes() {
    // Scoped to the agent: block — a loose match catches reasoning_effort under
    // other sections (summaries, image description) that this engine never reads.
    return /^\s*reasoning_effort:\s*["']?([\w-]+)/m.exec(yamlBlock(readHermesConfig(), "agent"))?.[1] || "";
  }
};

export function resolveDefaultEffort(engine: string, launcher: string = ""): string {
  const saved = readAiPreferences()[engine]?.effort;
  if (typeof saved === "string" && saved) return saved;
  return DEFAULT_EFFORT_READERS[engine]?.() || "";
}

// The serve server's own model list (GET /api/model): the only source that
// carries limit.context, so the pane gets a real context-window denominator.
// Falls back to [] (caller keeps the CLI spawn path as last resort).
export async function listOpencodeModelOptionsFromServer(): Promise<ModelOption[]> {
  try {
    const { ensureServer, authenticatedFetch } = await import("./opencodeServer.js");
    const base = await ensureServer();
    const res = await authenticatedFetch(`${base}/api/model`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const body = (await res.json()) as any;
    const models = Array.isArray(body?.data) ? body.data : [];
    return models
      .filter((m: any) => m?.id && m?.providerID)
      .map((m: any) => {
        const variants = Object.keys(m.variants || {});
        const efforts = variants.filter((v) => v !== "default");
        return {
          id: `${m.providerID}/${m.id}`,
          label: m.name || `${m.providerID}/${m.id}`,
          short: m.name || m.id,
          desc: "",
          efforts,
          // 'default' is a marker, not a reasoning level; medium is OpenCode's own middle.
          defaultEffort: m.variants?.medium ? "medium" : efforts[0] || "",
          contextWindow: m.limit?.context || 0
        };
      });
  } catch {
    return [];
  }
}

// Antigravity model ids come straight from `agy models` (format: `<id>\t<label>`).
export function listAntigravityModelOptions(): ModelOption[] {
  let out = "";
  try {
    const res = spawnSync("agy", ["models"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  return out.split("\n")
    .map((l) => l.trim())
    .filter((l) => Boolean(l) && !/^fetching/i.test(l))
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      const cleanId = (id || "").trim();
      const label = rest.join(" ").trim() || cleanId;
      const contextWindow = /claude/i.test(cleanId) ? 200000 : /gpt|oss/i.test(cleanId) ? 128000 : 1048576;
      return {
        id: cleanId,
        label,
        short: label,
        desc: "",
        efforts: [],
        defaultEffort: "",
        contextWindow
      };
    })
    .filter((m) => Boolean(m.id));
}

// List pi models over its rpc pipe — one spawnSync round trip, stdin carries the
// command, stdout the id-correlated response (`pi --list-models` has no JSON).
export function parsePiModelFrames(stdout: string | Buffer): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of String(stdout || "").split("\n")) {
    let frame: any;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame?.type !== "response" || frame.id !== "m1" || frame.success === false) continue;
    for (const m of Array.isArray(frame.data?.models) ? frame.data.models : []) {
      if (!m?.id || !m.provider) continue;
      const displayLabel = m.provider === "9router" ? m.id : (m.name || m.id);
      models.push({
        id: `${m.provider}/${m.id}`,
        provider: m.provider,
        label: displayLabel,
        short: displayLabel,
        desc: "",
        efforts: [],
        defaultEffort: "",
        contextWindow: m.contextWindow || 0
      });
    }
  }
  return models.sort((a, b) => (a.provider || "").localeCompare(b.provider || "") || a.label.localeCompare(b.label));
}

export function listPiModelOptions(): ModelOption[] {
  let out = "";
  try {
    const res = spawnSync("pi", ["--mode", "rpc", "--no-session"], {
      input: JSON.stringify({ id: "m1", type: "get_available_models" }) + "\n",
      encoding: "utf8",
      timeout: OPENCODE_CATALOG_TIMEOUT_MS
    });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  return parsePiModelFrames(out);
}

// List OMP models via `omp models --json`; omp already filters to providers with auth.
export function listOmpModelOptions(): ModelOption[] {
  let out = "";
  try {
    const res = spawnSync("omp", ["models", "--json"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  let models: any[] = [];
  try {
    models = JSON.parse(out).models || [];
  } catch {
    return [];
  }
  return models
    .filter((m: any) => m?.id && m.provider)
    .map((m: any) => {
      const id = m.selector || `${m.provider}/${m.id}`;
      // 9router in TUI displays m.id (e.g. ag/claude-sonnet-4-6, bzl/...); others use m.name || m.id
      const displayLabel = m.provider === "9router" ? m.id : (m.name || m.id);
      return {
        id,
        provider: m.provider,
        label: displayLabel,
        short: displayLabel,
        desc: "",
        efforts: Array.isArray(m.thinking) ? m.thinking : [],
        defaultEffort: "",
        contextWindow: m.contextWindow || 0
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

// List Devin models via `devin models list --format json`: families carry the
// provider label, each variant (reasoning level baked into the uid) one option.
export function listDevinModelOptions(): ModelOption[] {
  let out = "";
  try {
    const res = spawnSync("devin", ["models", "list", "--format", "json"], {
      encoding: "utf8",
      env: getExtendedEnv(),
      timeout: OPENCODE_CATALOG_TIMEOUT_MS
    });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  let families: any[] = [];
  try {
    families = JSON.parse(out).families || [];
  } catch {
    return [];
  }
  const options: ModelOption[] = [];
  for (const family of families) {
    for (const v of family.variants || []) {
      if (!v.model_uid) continue;
      options.push({
        id: v.model_uid,
        provider: family.family_label || family.slug || "Devin",
        label: v.label || v.model_uid,
        short: v.label || v.model_uid,
        desc: v.cost_summary || "",
        efforts: [],
        defaultEffort: "",
        // The catalog carries no window; usage_update reports the live one.
        contextWindow: 0
      });
    }
  }
  return options.sort((a, b) => (a.provider || "").localeCompare(b.provider || "") || a.label.localeCompare(b.label));
}

// Merge models matching OpenCode TUI structure:
// Recent at the top, followed by OpenCode Go and OpenCode Zen.
export async function listAllOpencodeModelOptions(): Promise<ModelOption[]> {
  const byId = new Map<string, ModelOption>();
  const recentIds: string[] = [];

  // 1. Read recent models from OpenCode state file
  try {
    const stateFile = path.join(os.homedir(), ".local", "state", "opencode", "model.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const r of state?.recent || []) {
      if (r?.providerID && r?.modelID) {
        recentIds.push(`${r.providerID}/${r.modelID}`);
      }
    }
  } catch {}

  // 2. Read CLI models (opencode models --verbose)
  for (const m of listOpencodeModelOptions()) {
    const provider = m.id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
    byId.set(m.id, {
      ...m,
      provider,
      label: m.label || m.id,
      short: m.short || m.id,
      desc: m.desc || "",
      contextWindow: m.contextWindow || 0
    });
  }

  // 3. Read server models (GET /api/model) carrying contextWindow and display names
  const serverModels = await listOpencodeModelOptionsFromServer();
  for (const m of serverModels) {
    const existing = byId.get(m.id);
    const provider = m.id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
    byId.set(m.id, {
      ...existing,
      ...m,
      provider,
      label: m.label || existing?.label || m.id,
      short: m.short || existing?.short || m.id
    });
  }

  // 4. Attach recent info
  const all = Array.from(byId.values()).map((m) => {
    const recIdx = recentIds.indexOf(m.id);
    return {
      ...m,
      recent: recIdx >= 0,
      recentRank: recIdx >= 0 ? recIdx : 999
    };
  });

  return all;
}

// ── Hermes ──────────────────────────────────────────────────────────────────
// hermes_constants.py VALID_REASONING_EFFORTS (0.21.4); "none" disables thinking.
export const HERMES_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const hermesConfigPath = () => path.join(os.homedir(), ".hermes", "config.yaml");
const readHermesConfig = (): string => {
  try { return fs.readFileSync(hermesConfigPath(), "utf8"); } catch { return ""; }
};

// Top-level `key:` block of a YAML file — a loose key match anywhere would catch
// the same name nested under another section.
function yamlBlock(text: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*$`, "m").exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = /^[A-Za-z_]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// The wire has no reasoning switch — config.yaml is the only door and it is read
// once per session build, so a change costs a config write + process recycle.
export function setHermesReasoningEffort(effort: string) {
  const file = hermesConfigPath();
  const text = fs.readFileSync(file, "utf8");
  const head = /^agent:[ \t]*$/m.exec(text);
  if (!head) throw new Error("No agent: block in ~/.hermes/config.yaml");
  const start = head.index + head[0].length;
  const rest = text.slice(start);
  const next = /^[A-Za-z_]/m.exec(rest);
  const end = next ? start + next.index : text.length;
  const block = text.slice(start, end);
  if (!/^[ \t]*reasoning_effort:/m.test(block)) throw new Error("No agent.reasoning_effort key in ~/.hermes/config.yaml");
  const patched = block.replace(/^([ \t]*reasoning_effort:\s*).*$/m, `$1${effort}`);
  fs.writeFileSync(file, text.slice(0, start) + patched + text.slice(end));
}

// The live catalog the running adapter absorbed from session/new — the connect ack
// serves it, so a reconnect never trades the full menu for the config fallback.
let hermesLiveCatalog: ModelOption[] | null = null;
export function setHermesLiveCatalog(options: ModelOption[] | null) {
  hermesLiveCatalog = Array.isArray(options) && options.length ? options : null;
}

export function listHermesModelOptions(): ModelOption[] {
  if (hermesLiveCatalog) return hermesLiveCatalog;
  const modelBlock = yamlBlock(readHermesConfig(), "model");
  const model = /^\s*default:\s*["']?([^"'\n]+)/m.exec(modelBlock)?.[1]?.trim() || "";
  if (!model) return [];
  const provider = /^\s*provider:\s*["']?([^"'\n]+)/m.exec(modelBlock)?.[1]?.trim() || "";
  // ids are "provider:model" on this wire (the picker's own encoding), so the
  // fallback row must match or a pick from it would 404 the session/set_model.
  const id = provider && !model.startsWith(`${provider}:`) ? `${provider}:${model}` : model;
  return [{ id, label: id, short: id, desc: "", efforts: [], defaultEffort: "", contextWindow: 0 }];
}
