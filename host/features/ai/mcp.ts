import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface McpServerItem {
  id: string;
  name: string;
  type: "stdio" | "http";
  command?: string;
  status: string;
}

/**
 * The MCP servers one engine actually has.
 *
 * Each engine reads its OWN config, and only its own. The codex branch used to run for
 * every engine, so the modal listed claude's servers as codex's and vice versa — and
 * opencode/antigravity, which have no reader of their own, showed claude's list as if it
 * were theirs. An engine with no reader returns nothing rather than borrowing another's.
 */
// Engine → its own MCP config reader. Each engine reads its OWN config, and only its
// own: the codex branch used to run for every engine, so the modal listed claude's
// servers as codex's and vice versa. An engine with no reader returns nothing rather
// than borrowing another's.
const MCP_SERVER_READERS: Record<string, (cwd?: string) => McpServerItem[]> = {
  claude: claudeServers,
  codex: codexServers,
  opencode: opencodeServers
};

export function listMcpServers(engine: string = "claude", cwd?: string): McpServerItem[] {
  return MCP_SERVER_READERS[engine]?.(cwd) ?? [];
}

/** OpenCode keeps them in ~/.config/opencode/opencode.json under mcp.servers. */
function opencodeServers(): McpServerItem[] {
  const file = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const servers = data?.mcp?.servers || {};
  return Object.entries(servers)
    .filter(([, cfg]: [string, any]) => cfg && !cfg.disabled)
    .map(([name, cfg]: [string, any]) => ({
      id: name,
      name,
      type: cfg.type === "remote" || cfg.url ? "http" : "stdio",
      command: cfg.url || (Array.isArray(cfg.command) ? cfg.command.join(" ") : String(cfg.command || "")),
      status: "configured"
    }));
}

const readJson = (file: string): any => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

// A url can carry a key in its query; the list only needs to say where the server is.
const bareUrl = (url: string) => String(url).split("?")[0];

function toItem(name: string, cfg: any, id = name): McpServerItem {
  return {
    id,
    name: id,
    type: cfg?.url ? "http" : "stdio",
    command: cfg?.url ? bareUrl(cfg.url) : cfg?.command || "",
    status: "configured"
  };
}

// A .mcp.json is either { mcpServers: {...} } or the bare name → config map.
const serversOf = (data: any): Record<string, any> => data?.mcpServers || (data && typeof data === "object" ? data : {});

/** cwd, then each parent up to the root: where a project-scope config may live. */
function ancestors(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = path.resolve(cwd); !out.includes(dir); dir = path.dirname(dir)) out.push(dir);
  return out;
}

/**
 * Claude's servers, by the scopes the CLI itself merges: user and per-project entries in
 * ~/.claude.json, the project's .mcp.json, and the .mcp.json of each enabled plugin.
 * ~/.claude/settings.json is kept for older setups. A name defined twice shows once.
 */
function claudeServers(cwd: string = process.cwd()): McpServerItem[] {
  const home = os.homedir();
  const out = new Map<string, McpServerItem>();
  const add = (name: string, cfg: any, id = name) => { if (!out.has(id)) out.set(id, toItem(name, cfg, id)); };

  const state = readJson(path.join(home, ".claude.json"));
  const dirs = ancestors(cwd);
  for (const dir of dirs) {
    for (const [name, cfg] of Object.entries(state?.projects?.[dir]?.mcpServers || {})) add(name, cfg);
  }
  for (const dir of dirs) {
    for (const [name, cfg] of Object.entries(serversOf(readJson(path.join(dir, ".mcp.json"))))) add(name, cfg);
  }
  for (const [name, cfg] of Object.entries(state?.mcpServers || {})) add(name, cfg);
  for (const [name, cfg] of Object.entries(readJson(path.join(home, ".claude", "settings.json"))?.mcpServers || {})) add(name, cfg);

  const enabled = readJson(path.join(home, ".claude", "settings.json"))?.enabledPlugins || {};
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  for (const [key, entries] of Object.entries<any>(installed?.plugins || {})) {
    if (!enabled[key]) continue;
    const [plugin] = key.split("@");
    const installPath = Array.isArray(entries) ? entries[0]?.installPath : null;
    if (!installPath) continue;
    for (const [name, cfg] of Object.entries(serversOf(readJson(path.join(installPath, ".mcp.json"))))) {
      add(name, cfg, `plugin:${plugin}:${name}`);
    }
  }
  const needsAuth = needsAuthIds(home);
  return [...out.values()].map((s) => (needsAuth.has(s.id) ? { ...s, status: "needs-auth" } : s));
}

// shortcut: the CLI's own default lifetime for an entry without ttlMs, assumed from its binary; revisit if the TUI and this list disagree.
const NEEDS_AUTH_DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Servers the CLI flagged as unauthenticated: live entries of its needs-auth cache. */
function needsAuthIds(home: string): Set<string> {
  const cache = readJson(path.join(home, ".claude", "mcp-needs-auth-cache.json")) || {};
  const now = Date.now();
  return new Set(
    Object.entries<any>(cache)
      .filter(([, e]) => now - e?.timestamp < (e?.ttlMs ?? NEEDS_AUTH_DEFAULT_TTL_MS))
      .map(([id]) => id)
  );
}

/**
 * Codex keeps them in ~/.codex/config.toml as `[mcp_servers.<name>]` tables.
 *
 * Only the tables that ARE a server. The same file nests options under them
 * (`[mcp_servers."9remote".http_headers]`, `[mcp_servers.node_repl.env]`), and matching
 * the heading alone listed those as servers of their own — four phantom rows on this
 * machine, named after the option rather than the server.
 */
function codexServers(): McpServerItem[] {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: McpServerItem[] = [];
  const seen = new Set<string>();
  // The name may be quoted (a dotted or spaced name), and an option table adds a suffix.
  for (const m of text.matchAll(/^\s*\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)((?:\.[^\]]+)*)\]\s*$/gm)) {
    if (m[2]) continue; // a sub-table is an option of the server above, not a server
    const name = m[1].replace(/^"|"$/g, "");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: name, name, type: "stdio", status: "configured" });
  }
  return out;
}
