// Registry-driven hook management mapping tool events to working/blocked/done.
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { SERVER_PORT, PATHS as APP_PATHS, CLAUDE_SCROLLBACK_ENV, AI_TOOLS } from "../../lib/constants.js";
import { CLAUDE_QUESTION_WAIT_MS } from "../ai/constants.js";
import { writeJsonAtomic } from "../../lib/atomicFile.js";
import { hookSessionIdKeys } from "./agentCatalog.js";
import { claudeProfileDirs } from "../ai/claudeProfile.js";

type HookEntry = { command?: unknown; hooks?: HookEntry[]; [k: string]: unknown };
type HookSettings = { hooks?: Record<string, HookEntry[]>; env?: Record<string, string>; name?: string; description?: string; [k: string]: unknown };
type CodexHookRow = { key: string; hash: string };
type ToolHookResult = { success: boolean; error?: string; untrusted?: unknown[] };
type ToolHook = { enable(filePath?: string): ToolHookResult; disable(filePath?: string): ToolHookResult; isEnabled(filePath?: string): boolean };
const errMsg = (e: unknown): string => (e as { message: string }).message;

const NOTIFY_URL = `http://localhost:${SERVER_PORT}/api/notify`;
// JS identifier cannot start with a digit, so plugin export name differs from the file mark
const OPENCODE_PLUGIN_MARK = "nineRemoteNotify";

// Backup of user's original env values, to restore on disable
const CLAUDE_ENV_BACKUP_FILE = path.join(APP_PATHS.STATE, "claudeEnvBackup.json");

const homeSub = (...p: string[]) => path.join(os.homedir(), ...p);
const envDir = (envVar: string, ...fallback: string[]) => {
  const v = process.env[envVar];
  return v && v.trim() ? v.trim() : homeSub(...fallback);
};

// Every profile's settings.json: the CLI reads hooks from its own config dir, so each one needs ours.
const claudeSettingsFiles = (): string[] => claudeProfileDirs().map((dir) => path.join(dir, "settings.json"));

const PATHS: Record<string, () => string> = {
  claude: () => homeSub(".claude", "settings.json"),
  codex: () => homeSub(".codex", "config.toml"),
  codexHooks: () => homeSub(".codex", "hooks.json"),
  codexScript: () => homeSub(".codex", "9remote-notify.sh"),
  opencode: () => homeSub(".config", "opencode", "plugin", `${OPENCODE_PLUGIN_MARK}.js`),
  grok: () => path.join(envDir("GROK_HOME", ".grok"), "hooks", "9remote.json"),
  cursor: () => homeSub(".cursor", "hooks.json"),
  antigravity: () => homeSub(".gemini", "config", "hooks.json"),
  kiro: () => path.join(envDir("KIRO_HOME", ".kiro"), "agents", "9remote.json"),
  copilot: () => path.join(envDir("COPILOT_HOME", ".copilot"), "config.json"),
  codebuddy: () => path.join(envDir("CODEBUDDY_CONFIG_DIR", ".codebuddy"), "settings.json"),
  factory: () => homeSub(".factory", "settings.json"),
  qoder: () => path.join(envDir("QODER_CONFIG_DIR", ".qoder"), "settings.json"),
  rovodev: () => homeSub(".rovodev", "config.yml"),
  hermes: () => path.join(envDir("HERMES_HOME", ".hermes"), "config.yaml"),
  amp: () => homeSub(".config", "amp", "plugins", "9remote.ts"),
  // Same Claude-style nested hooks the CLI's own config already carries.
  devin: () => homeSub(".config", "devin", "config.json"),
  pi: () => path.join(envDir("PI_CODING_AGENT_DIR", ".pi", "agent"), "extensions", "9remote.ts"),
  // omp resolves the same env var as its whole agent dir (default ~/.omp/agent).
  // ponytail: profile-scoped installs (~/.omp/profiles/<name>/agent) are not covered; revisit when a profile user reports it.
  omp: () => path.join(envDir("PI_CODING_AGENT_DIR", ".omp", "agent"), "extensions", "9remote.ts"),
};

const BINARIES: Record<string, string> = {
  claude: "claude", codex: "codex", opencode: "opencode",
  grok: "grok", cursor: "cursor-agent", antigravity: "agy", kiro: "kiro-cli",
  copilot: "copilot", codebuddy: "codebuddy", factory: "droid", qoder: "qodercli",
  rovodev: "acli", hermes: "hermes", amp: "amp", pi: "pi", omp: "omp", devin: "devin",
};

// Capture conversation ID from stdin JSON to support relaunching later.
const buildCurlCmd = (type: string, tool: string, { sessionId = false } = {}) => {
  const key = sessionId ? hookSessionIdKeys(tool)[0] : null;
  const prefix = key ? `csid=$(cat 2>/dev/null | sed -n 's/.*"${key}" *: *"\\([^"]*\\)".*/\\1/p'); ` : "";
  const extra = key ? "&csid=$csid" : "";
  return `${prefix}command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 "${NOTIFY_URL}?type=${type}&sessionId=$NINE_REMOTE_SESSION_ID${extra}&tool=${tool}" > /dev/null 2>&1 & true`;
};

// Legacy config-dir fallback for the original four tools (binary-on-PATH is the primary check)
const TOOL_DIRS: Record<string, () => string | string[]> = {
  claude: () => claudeProfileDirs(),
  codex: () => homeSub(".codex"),
  opencode: () => [homeSub(".config", "opencode"), homeSub(".opencode")],
};

// Timeout unit differs per agent: some nested-JSON hooks want seconds, Claude-style want ms
const SEC = (ms: number) => Math.ceil(ms / 1000);
const STOP_MS = 5000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const yq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function upsertBlock(filePath: string, begin: string, end: string, block: string) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  content = content.replace(new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, "g"), "");
  if (content.length && !content.endsWith("\n")) content += "\n";
  content += `${block}\n`;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function removeBlock(filePath: string, begin: string, end: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, content.replace(new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, "g"), ""), "utf8");
}

function readJsonFile<T extends object = HookSettings>(filePath: string): Partial<T> {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}
  return {};
}

function writeJsonFile(filePath: string, data: unknown) {
  // Atomic write to prevent corrupting third-party tool settings.
  writeJsonAtomic(filePath, data, { mode: 0o644 });
}

// AskUserQuestion and permission dialogs go to the chat that drives this TUI (api/question.ts); outside a
// 9remote chat the endpoint answers empty and the TUI asks as usual. Held up to the
// endpoint's wait, so the hook timeout sits just above it. `&tool=` marks it as ours.
const QUESTION_TIMEOUT_S = Math.ceil(CLAUDE_QUESTION_WAIT_MS / 1000) + 30;
const gateEntry = (matcher: string): HookEntry => ({
  matcher,
  hooks: [{
    type: "command",
    command: `[ -n "$NINE_REMOTE_SESSION_ID" ] && command -v curl >/dev/null 2>&1 && curl -s --max-time ${QUESTION_TIMEOUT_S} -X POST -H "Content-Type: application/json" --data-binary @- "http://localhost:${SERVER_PORT}/api/claude/question?sessionId=$NINE_REMOTE_SESSION_ID&tool=claude&csid=hold" 2>/dev/null; true`,
    timeout: QUESTION_TIMEOUT_S
  }]
});

// One backup per profile's settings file, so a second profile never overwrites the first one's originals.
function applyClaudeEnv(settings: HookSettings, filePath: string) {
  const backup: Record<string, string | null> = {};
  const env: Record<string, string> = settings.env || {};
  for (const k of Object.keys(CLAUDE_SCROLLBACK_ENV)) backup[k] = env[k] ?? null;
  const all = readJsonFile<Record<string, Record<string, string | null>>>(CLAUDE_ENV_BACKUP_FILE);
  writeJsonFile(CLAUDE_ENV_BACKUP_FILE, { ...all, [filePath]: backup });
  settings.env = { ...env, ...CLAUDE_SCROLLBACK_ENV };
}

// ─── Kind: json-nested (Claude-style hooks object) ──────────────────────────
function makeNestedJsonHook(tool: string, events: Record<string, string>, timeoutFn: (ms: number) => number, { matchers = {}, extra, sessionId = false, extraEntries = {} }: { matchers?: Record<string, string>; extra?: (s: HookSettings, filePath: string) => void; sessionId?: boolean; extraEntries?: Record<string, HookEntry[]> } = {}) {
  const buildEntry = (key: string, type: string): HookEntry => ({
    hooks: [{ type: "command", command: buildCurlCmd(type, tool, { sessionId }), timeout: timeoutFn(STOP_MS) }],
    ...(matchers[key] != null ? { matcher: matchers[key] } : {}),
  });
  const isOwn = (grp: HookEntry) => grp?.hooks?.some((h) => typeof h.command === "string" && h.command.includes(`&tool=${tool}`));
  const isCurrent = (grp: HookEntry) => grp?.hooks?.some((h) =>
    typeof h.command === "string" && h.command.includes(`&tool=${tool}`) && (!sessionId || h.command.includes("&csid=")));
  return {
    enable(filePath: string) {
      const settings = readJsonFile(filePath);
      const hooks: Record<string, HookEntry[]> = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((g) => !isOwn(g)), buildEntry(key, type), ...(extraEntries[key] || [])];
      }
      settings.hooks = hooks;
      if (extra) extra(settings, filePath);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath: string) {
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(events)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((g) => !isOwn(g));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      if (extra) extra(settings, filePath);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath: string) {
      const s = readJsonFile(filePath);
      // An extra entry missing (an older install) re-runs enable, which adds it.
      const extrasIn = Object.entries(extraEntries).every(([k, list]) =>
        list.every((e) => (s.hooks?.[k] || []).some((g) => JSON.stringify(g) === JSON.stringify(e))));
      return extrasIn && Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isCurrent));
    },
  };
}

// ─── Kind: json-flat (Cursor) — flat hooks.{event}:[{command}], no timeout ───
function makeFlatJsonHook(tool: string, events: Record<string, string>, { extra }: { extra?: (s: HookSettings) => void } = {}) {
  const isOwn = (e: HookEntry) => typeof e?.command === "string" && e.command.includes(`&tool=${tool}`);
  const hook = {
    enable(filePath: string) {
      const settings = readJsonFile(filePath);
      const hooks: Record<string, HookEntry[]> = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((e) => !isOwn(e)), { command: buildCurlCmd(type, tool) }];
      }
      settings.hooks = hooks;
      if (extra) extra(settings);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath: string) {
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(events)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((e) => !isOwn(e));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      if (extra) extra(settings);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath: string) {
      const s = readJsonFile(filePath);
      return Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isOwn));
    },
  };
  return hook;
}

// ─── Kind: json-group (Antigravity) — entries under a named root group, SEC timeout ─
function makeGroupJsonHook(tool: string, groupName: string, events: Record<string, string>) {
  const hook = {
    enable(filePath: string) {
      const settings = readJsonFile(filePath);
      const group: Record<string, HookEntry[]> = {};
      for (const [key, type] of Object.entries(events)) {
        group[key] = [{ type: "command", command: buildCurlCmd(type, tool), timeout: SEC(STOP_MS) }];
      }
      settings[groupName] = group;
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath: string) {
      const settings = readJsonFile(filePath);
      delete settings[groupName];
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath: string) {
      const s = readJsonFile(filePath);
      return !!s[groupName];
    },
  };
  return hook;
}

// ─── Kind: json-agent (Kiro) — custom agent definition, timeout_ms ──────────
function makeAgentJsonHook(tool: string, events: Record<string, string>, { name, description }: { name?: string; description?: string } = {}) {
  const isOwn = (e: HookEntry) => typeof e?.command === "string" && e.command.includes(`&tool=${tool}`);
  const hook = {
    enable(filePath: string) {
      const settings = readJsonFile(filePath);
      settings.name = settings.name || name || "9remote";
      settings.description = settings.description || description || `9Remote hooks for ${tool} CLI.`;
      if (!Array.isArray(settings.tools)) settings.tools = ["*"];
      const hooks: Record<string, HookEntry[]> = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((e) => !isOwn(e)), { command: buildCurlCmd(type, tool), timeout_ms: STOP_MS }];
      }
      settings.hooks = hooks;
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath: string) {
      if (!fs.existsSync(filePath)) return { success: true };
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(events)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((e) => !isOwn(e));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath: string) {
      const s = readJsonFile(filePath);
      return Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isOwn));
    },
  };
  return hook;
}

// ─── Kind: yaml-block (Hermes / Rovo Dev) — marker-delimited YAML block ─────
function makeYamlBlockHook(tool: string, { begin, end, items }: { begin: string; end: string; items: { event: string; type: string }[] }) {
  const buildBlock = () => {
    const lines = [begin, "hooks:",
      ...items.map(({ event, type }) => `  ${event}:\n    - command: ${yq(buildCurlCmd(type, tool))}\n      timeout: 5`),
      end];
    return lines.join("\n");
  };
  return {
    enable(filePath: string) { upsertBlock(filePath, begin, end, buildBlock()); return { success: true }; },
    disable(filePath: string) { removeBlock(filePath, begin, end); return { success: true }; },
    isEnabled(filePath: string) { return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(begin); },
  };
}

// ─── Kind: hooks-json-codex — codex 0.154's own hook file, plus the trust it needs ──
// Codex hooks require positional trusted sha256 hashes in config.toml.
const CODEX_HOOK_EVENTS = {
  UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
  Stop: "done", PermissionRequest: "blocked",
};
const CODEX_EVENT_KEY = (ev: string) => ev.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const CODEX_EVENT_OF_KEY = Object.fromEntries(
  Object.keys(CODEX_HOOK_EVENTS).map((ev) => [CODEX_EVENT_KEY(ev), ev])
);
const CODEX_STATE_HEAD = /^\[hooks\.state\."(?<key>[^"]+)"\]$/m;
const CODEX_APP_SERVER_TIMEOUT_MS = 15000;

function codexHookList(bin: string): Promise<CodexHookRow[]> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve([]);
    }
    let buf = "";
    let done = false;
    const finish = (out: CodexHookRow[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(out);
    };
    const timer = setTimeout(() => finish([]), CODEX_APP_SERVER_TIMEOUT_MS);
    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));
    // A codex that dies before reading stdin (broken config) EPIPEs the write —
    // without a listener that crash takes the whole host down.
    child.stdin.on("error", () => finish([]));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: {} }) + "\n");
          continue;
        }
        if (msg.id !== 2) continue;
        const rows = [];
        for (const cwd of msg.result?.data || []) {
          for (const h of cwd.hooks || []) {
            if (h.currentHash) rows.push({ key: h.key, hash: h.currentHash });
          }
        }
        finish(rows);
        return;
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "9remote", version: "1" } } }) + "\n");
  });
}

// Codex returns "sha256:<hex>"; stored verbatim to prevent double-prefixing.
const codexHashValue = (hash: string) => (/^sha256:/.test(hash) ? hash : `sha256:${hash}`);

// TOML basic strings treat \ as an escape — raw Windows paths ("C:\Users\…") break
// codex's config parse ("too few unicode value digits"). Always write keys escaped.
const tomlEscapeKey = (k: string) => k.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
// Match keys however they were written: escaped (current) or raw (pre-fix, broken).
// ponytail: collapses backslash runs — real file paths never contain "\\".
const sameCodexKey = (a: string, b: string) => a.replace(/\\+/g, "\\") === b.replace(/\\+/g, "\\");

function codexHandlersIn(filePath: string) {
  const hooks: Record<string, HookEntry[]> = readJsonFile(filePath).hooks || {};
  const out: { key: string; event: string; command: string }[] = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      (group?.hooks || []).forEach((h, hi) => {
        if (typeof h?.command !== "string") return;
        out.push({ key: `${filePath}:${CODEX_EVENT_KEY(ev)}:${gi}:${hi}`, event: ev, command: h.command });
      });
    });
  }
  return out;
}

// Targeted line replacement for trusted_hash entries to preserve user settings.
function upsertCodexTrust(filePath: string, entries: { key: string; hash: string }[]) {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = content.split("\n");
  const out = [];
  const remaining = new Map();
  for (const e of entries) remaining.set(e.key, codexHashValue(e.hash));
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CODEX_STATE_HEAD);
    const next = lines[i + 1] || "";
    if (!match || !/^\s*trusted_hash\s*=/.test(next)) { out.push(lines[i]); continue; }
    const hit = [...remaining.entries()].find(([k]) => sameCodexKey(k, match[1]));
    if (hit) {
      remaining.delete(hit[0]);
      out.push(`[hooks.state."${tomlEscapeKey(hit[0])}"]`, `trusted_hash = "${hit[1]}"`);
      i++;
      continue;
    }
    // A second copy of a key we already placed (old versions appended theirs next to
    // codex's own escaped entry) is a duplicate table — drop it, the first copy wins.
    if (entries.some((e) => sameCodexKey(e.key, match[1]))) { i++; continue; }
    out.push(lines[i], next); i++;
  }
  for (const [key, hash] of remaining) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`[hooks.state."${tomlEscapeKey(key)}"]`, `trusted_hash = "${hash}"`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, out.join("\n"), "utf8");
}

// Query codex app-server to compute and trust hook hashes in config.toml.
export async function reconcileCodexHookTrust({ run = codexHookList, bin = BINARIES.codex } = {}) {
  const hooksPath = PATHS.codexHooks();
  const reported = await run(bin);
  const byKey = new Map(reported.map((r) => [r.key, r.hash]));
  const ours = codexHandlersIn(hooksPath).filter((h) => h.command.includes("&tool=codex"));
  const entries = [];
  const missing = [];
  for (const h of ours) {
    const hash = byKey.get(h.key);
    if (hash) entries.push({ key: h.key, hash });
    else missing.push(h.key);
  }
  if (!reported.length) return { entries: [], missing, skipped: true };
  upsertCodexTrust(PATHS.codex(), entries);
  return { entries, missing, skipped: false };
}

// Drop trust entries for handlers occupied before removal to avoid shifting foreign keys.
function dropCodexTrust(filePath: string, goneKeys: Set<string>) {
  if (!fs.existsSync(filePath) || !goneKeys.size) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CODEX_STATE_HEAD);
    const next = lines[i + 1] || "";
    if (!match || !/^\s*trusted_hash\s*=/.test(next)) { out.push(lines[i]); continue; }
    if (![...goneKeys].some((g) => sameCodexKey(g, match[1]))) { out.push(lines[i], next); i++; continue; }
    i++;
    if (out[out.length - 1] === "") out.pop();
  }
  fs.writeFileSync(filePath, out.join("\n"), "utf8");
}

// Remove obsolete legacy notify configuration.
const CODEX_LEGACY_BLOCK_RE = /# 9Remote notification\nnotify\s*=.*\n?/g;
const CODEX_LEGACY_SAVED_RE = /^# 9Remote-saved: (notify\s*=.*)$/m;

function dropLegacyCodexNotify() {
  const scriptPath = PATHS.codexScript();
  const filePath = PATHS.codex();
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf8");
    let next = content.replace(CODEX_LEGACY_BLOCK_RE, "");
    const saved = next.match(CODEX_LEGACY_SAVED_RE);
    if (saved && !saved[1].includes(scriptPath)) next = next.replace(CODEX_LEGACY_SAVED_RE, "$1");
    else if (saved) next = next.replace(/^# 9Remote-saved: notify\s*=.*\n?/m, "");
    next = next.replace(/^notify\s*=\s*\[[^\n]*9remote-notify\.sh[^\n]*\]\s*\n?/m, "");
    if (next !== content) fs.writeFileSync(filePath, next, "utf8");
  }
  if (fs.existsSync(scriptPath)) { try { fs.unlinkSync(scriptPath); } catch {} }
}

const codexHook = {
  enable() {
    const filePath = PATHS.codexHooks();
    const settings = readJsonFile(filePath);
    const hooks: Record<string, HookEntry[]> = { ...(settings.hooks || {}) };
    for (const [key, type] of Object.entries(CODEX_HOOK_EVENTS)) {
      hooks[key] = [...(hooks[key] || []).filter((g) => !isOwnCodexGroup(g)), buildCodexGroup(type)];
    }
    settings.hooks = hooks;
    writeJsonFile(filePath, settings);
    dropLegacyCodexNotify();
    return { success: true };
  },
  disable() {
    const filePath = PATHS.codexHooks();
    const goneKeys = new Set(codexHandlersIn(filePath).filter((h) => h.command.includes("&tool=codex")).map((h) => h.key));
    if (fs.existsSync(filePath)) {
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(CODEX_HOOK_EVENTS)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((g) => !isOwnCodexGroup(g));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeJsonFile(filePath, settings);
    }
    dropCodexTrust(PATHS.codex(), goneKeys);
    return { success: true };
  },
  isEnabled() {
    const hooks: Record<string, HookEntry[]> = readJsonFile(PATHS.codexHooks()).hooks || {};
    return Object.keys(CODEX_HOOK_EVENTS).every((k) => (hooks[k] || []).some(isOwnCodexGroup));
  },
};

function isOwnCodexGroup(group: HookEntry) {
  return (group?.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("&tool=codex"));
}

function buildCodexGroup(type: string) {
  return { hooks: [{ type: "command", command: buildCurlCmd(type, "codex", { sessionId: true }), timeout: SEC(STOP_MS) }] };
}


// ─── Kind: js-plugin-opencode — JS plugin emitting per-event fetch ──────────
function buildOpencodePlugin() {
  return `// 9Remote OpenCode status plugin (auto-generated, OpenCode v2)
const base = ${JSON.stringify(NOTIFY_URL)};
const post = (type, conv) => {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  let url = base + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=opencode";
  if (conv) url += "&sessionID=" + encodeURIComponent(conv);
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch {}
};
export default {
  id: "9remote-notify",
  async setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const t = event?.type;
        if (!t) continue;
        const props = event.properties || {};
        const conv = props.sessionID || props.sessionId || props.info?.sessionID || props.info?.id;
        if (t === "session.idle") post("done", conv);
        else if (t === "permission.asked" || t === "question.asked" || t === "session.error") post("blocked", conv);
        else if (t === "session.compacted" || t === "permission.replied" || t === "question.replied" || t === "message.updated") post("working", conv);
      }
    })().catch(() => {});
    return () => controller.abort();
  },
};
`;
}
const opencodeHook = {
  enable() {
    const filePath = PATHS.opencode();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buildOpencodePlugin(), "utf8");
    return { success: true };
  },
  disable() {
    const filePath = PATHS.opencode();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  },
  // A plugin written before it reported conversation ids is stale, not enabled —
  // otherwise the UI never re-runs enable() and the id never starts arriving.
  isEnabled() {
    const filePath = PATHS.opencode();
    const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    return source.includes("id: \"9remote-notify\"") && source.includes("ctx.event.subscribe");
  },
};

// ─── Kind: ts-plugin (Amp / Pi) — TS plugin with start + end events ─────────
function buildTsPlugin(tool: string, api: string, startEvent: string, endEvent: string) {
  return `// 9Remote ${tool} status plugin (auto-generated)
function post(type) {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  const url = ${JSON.stringify(NOTIFY_URL)} + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=${tool}";
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch (_) {}
}
export default function (${api}) {
  ${api}.on(${JSON.stringify(startEvent)}, async () => post("working"));
  ${api}.on(${JSON.stringify(endEvent)}, async () => post("done"));
}
`;
}

// omp variant: also reports the CLI's own session id so a TUI terminal can be
// switched to the chat UI. hasUI gates subagent/task sessions, which share this
// process's env but must not claim the terminal's conversation.
function buildOmpPlugin() {
  return `// 9Remote omp status plugin (auto-generated)
function post(type, csid) {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  let url = ${JSON.stringify(NOTIFY_URL)} + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=omp";
  if (csid) url += "&csid=" + encodeURIComponent(csid);
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch (_) {}
}
const csidOf = (ctx) => { try { return ctx?.sessionManager?.getSessionId() || ""; } catch { return ""; } };
export default function (pi) {
  pi.on("session_start", async (_e, ctx) => { if (ctx?.hasUI) post("idle", csidOf(ctx)); });
  pi.on("session_switch", async (_e, ctx) => { if (ctx?.hasUI) post("idle", csidOf(ctx)); });
  pi.on("agent_start", async (_e, ctx) => { if (ctx?.hasUI) post("working", csidOf(ctx)); });
  pi.on("agent_end", async (_e, ctx) => { if (ctx?.hasUI) post("done", csidOf(ctx)); });
}
`;
}

// ─── Registry ───────────────────────────────────────────────────────────────
// Each entry builds its hook object via the kind factory. Add a tool → add an entry.
const HERMES_BEGIN = "# 9remote hooks begin";
const HERMES_END = "# 9remote hooks end";
const ROVO_BEGIN = "  # 9remote hooks begin";
const ROVO_END = "  # 9remote hooks end";

const TOOL_REGISTRY: Record<string, ToolHook> = {
  claude: makeNestedJsonHook("claude",
    {
      UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
      Stop: "done", PermissionRequest: "blocked", Notification: "blocked",
      SubagentStart: "working", SubagentStop: "working",
      PreCompact: "working", PostCompact: "working",
      Elicitation: "blocked",
    },
    (ms) => ms,
    {
      matchers: { Notification: "permission_prompt" },
      extra: applyClaudeEnv,
      sessionId: true,
      extraEntries: {
        PreToolUse: [gateEntry("AskUserQuestion")],
        PermissionRequest: [gateEntry("")],
        Elicitation: [gateEntry("")],
      },
    }),
  // Claude-style hooks in the CLI's own config; the session_id key matches agentCatalog.
  devin: makeNestedJsonHook("devin",
    { UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
      Stop: "done", PermissionRequest: "blocked" },
    (ms) => ms,
    { sessionId: true }),
  codex: codexHook,
  opencode: opencodeHook,
  grok: makeNestedJsonHook("grok",
    { UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working", Stop: "done", Notification: "blocked" },
    SEC),
  cursor: makeFlatJsonHook("cursor",
    { stop: "done", beforeShellExecution: "blocked", beforeToolCall: "working" },
    { extra: (s) => { s.version = s.version || 1; } }),
  antigravity: makeGroupJsonHook("antigravity", "9remote",
    { UserPromptSubmit: "working", PreToolUse: "working", Stop: "done", Notification: "blocked" }),
  kiro: makeAgentJsonHook("kiro",
    { UserPromptSubmit: "working", PostToolUse: "working", preToolUse: "blocked", stop: "done" }),
  copilot: makeNestedJsonHook("copilot",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  codebuddy: makeNestedJsonHook("codebuddy",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  factory: makeNestedJsonHook("factory",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  qoder: makeNestedJsonHook("qoder",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  rovodev: makeYamlBlockHook("rovodev", {
    begin: ROVO_BEGIN, end: ROVO_END,
    items: [
      { event: "on_complete", type: "done" },
      { event: "on_error", type: "done" },
      { event: "on_tool_permission", type: "blocked" },
      { event: "on_message", type: "working" },
      { event: "on_tool_start", type: "working" },
    ],
  }),
  // Hermes: YAML block + companion shell-hooks-allowlist.json (dynamic path next to config).
  hermes: (() => {
    const base = makeYamlBlockHook("hermes", {
      begin: HERMES_BEGIN, end: HERMES_END,
      items: [
        { event: "pre_llm_call", type: "working" },
        { event: "pre_tool_call", type: "working" },
        { event: "post_tool_call", type: "working" },
        { event: "pre_approval_request", type: "blocked" },
        { event: "post_llm_call", type: "done" },
      ],
    });
    const allowlistPath = () => path.join(path.dirname(PATHS.hermes()), "shell-hooks-allowlist.json");
    return {
      enable: () => {
        const res = base.enable(PATHS.hermes());
        const al = readJsonFile<{ approvals: HookEntry[] }>(allowlistPath());
        const others = (al.approvals || []).filter((a) => !(typeof a.command === "string" && a.command.includes("&tool=hermes")));
        al.approvals = [...others, ...[
          { event: "pre_llm_call", type: "working" },
          { event: "pre_tool_call", type: "working" },
          { event: "post_tool_call", type: "working" },
          { event: "pre_approval_request", type: "blocked" },
          { event: "post_llm_call", type: "done" },
        ].map(({ event, type }) => ({ event, command: buildCurlCmd(type, "hermes"), approved_at: "2020-01-01T00:00:00Z" }))];
        writeJsonFile(allowlistPath(), al);
        return res;
      },
      disable: () => {
        const res = base.disable(PATHS.hermes());
        const alPath = allowlistPath();
        if (fs.existsSync(alPath)) {
          const al = readJsonFile<{ approvals: HookEntry[] }>(alPath);
          al.approvals = (al.approvals || []).filter((a) => !(typeof a.command === "string" && a.command.includes("&tool=hermes")));
          if (al.approvals.length) writeJsonFile(alPath, al);
          else fs.unlinkSync(alPath);
        }
        return res;
      },
      isEnabled: () => base.isEnabled(PATHS.hermes()),
    };
  })(),
  amp: {
    enable() {
      const filePath = PATHS.amp();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buildTsPlugin("amp", "amp", "agent.start", "agent.end"), "utf8");
      return { success: true };
    },
    disable() { if (fs.existsSync(PATHS.amp())) fs.unlinkSync(PATHS.amp()); return { success: true }; },
    isEnabled() { return fs.existsSync(PATHS.amp()); },
  },
  pi: {
    enable() {
      const filePath = PATHS.pi();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buildTsPlugin("pi", "pi", "agent_start", "agent_end"), "utf8");
      return { success: true };
    },
    disable() { if (fs.existsSync(PATHS.pi())) fs.unlinkSync(PATHS.pi()); return { success: true }; },
    isEnabled() { return fs.existsSync(PATHS.pi()); },
  },
  omp: {
    enable() {
      const filePath = PATHS.omp();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buildOmpPlugin(), "utf8");
      return { success: true };
    },
    disable() { if (fs.existsSync(PATHS.omp())) fs.unlinkSync(PATHS.omp()); return { success: true }; },
    isEnabled() { return fs.existsSync(PATHS.omp()); },
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────
export const SUPPORTED_TOOLS = AI_TOOLS;

// The files one tool's hook lives in: claude has one per profile, every other tool has one.
const hookFiles = (tool: string): string[] => (tool === "claude" ? claudeSettingsFiles() : [PATHS[tool]()]);
const FILELESS_TOOLS = new Set(["codex", "opencode", "amp", "pi", "omp"]);

function runOnFiles(tool: string, action: "enable" | "disable"): ToolHookResult {
  const hook = TOOL_REGISTRY[tool];
  if (!hook) return { success: false, error: "Unknown tool" };
  try {
    if (FILELESS_TOOLS.has(tool)) return hook[action]();
    const results = hookFiles(tool).map((file) => hook[action](file));
    const failed = results.find((r) => !r.success);
    return failed ?? { success: true };
  } catch (e) {
    return { success: false, error: errMsg(e) };
  }
}

export const enableToolHook = (tool: string): ToolHookResult => runOnFiles(tool, "enable");
export const disableToolHook = (tool: string): ToolHookResult => runOnFiles(tool, "disable");

function isToolHookEnabled(tool: string) {
  const hook = TOOL_REGISTRY[tool];
  if (!hook) return false;
  if (FILELESS_TOOLS.has(tool)) return hook.isEnabled();
  return hookFiles(tool).every((file) => hook.isEnabled(file));
}

function binaryOnPath(bin: string) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return dirs.some((d) => exts.some((ext) => {
    try { return fs.existsSync(path.join(d, bin + ext)); } catch { return false; }
  }));
}

function isToolInstalled(tool: string) {
  const bin = BINARIES[tool];
  if (bin && binaryOnPath(bin)) return true;
  const dirs = TOOL_DIRS[tool]?.();
  if (!dirs) return false;
  return (Array.isArray(dirs) ? dirs : [dirs]).some((d) => fs.existsSync(d));
}

// Idempotently enable hooks for all installed AI tools on startup.
export function autoEnableInstalledHooks() {
  const result: Record<string, boolean> = {};
  for (const tool of SUPPORTED_TOOLS) {
    if (!isToolInstalled(tool)) continue;
    try {
      const r = enableToolHook(tool);
      result[tool] = r.success && !r.untrusted?.length;
    } catch { result[tool] = false; }
  }
  return result;
}

export async function reconcileCodexTrust() {
  if (!isToolInstalled("codex")) return null;
  try {
    const { missing } = await reconcileCodexHookTrust();
    if (missing.length) console.warn(`⚠️  codex hooks written but not trusted: ${missing.length} — run codex and trust them`);
    return missing.length ? { untrusted: missing.length } : { untrusted: 0 };
  } catch (e) {
    console.warn(`⚠️  codex hook trust failed: ${errMsg(e)}`);
    return { error: errMsg(e) };
  }
}

export function getHookStatus() {
  const status: Record<string, { installed: boolean; enabled: boolean }> = {};
  for (const tool of SUPPORTED_TOOLS) {
    status[tool] = { installed: isToolInstalled(tool), enabled: isToolHookEnabled(tool) };
  }
  return status;
}

export function reconcileClaudeEnv() {
  for (const filePath of claudeSettingsFiles()) {
    const settings = readJsonFile<HookSettings>(filePath);
    if (!settings.hooks?.Stop && !settings.hooks?.Notification) continue;
    const env: Record<string, string> = settings.env || {};
    if (!Object.entries(CLAUDE_SCROLLBACK_ENV).some(([k, v]) => env[k] !== v)) continue;
    applyClaudeEnv(settings, filePath);
    writeJsonFile(filePath, settings);
  }
}
