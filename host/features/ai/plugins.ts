import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface PluginItem {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  skills: number;
  agents: number;
  commands: number;
}

export interface InstalledPlugin extends PluginItem {
  installPath: string;
}

const readJson = (file: string): any => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

const entriesOf = (dir: string): fs.Dirent[] => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

// A skill is a directory holding SKILL.md; agents and commands are plain .md files.
const countSkills = (dir: string) => entriesOf(dir).filter((e) => fs.existsSync(path.join(dir, e.name, "SKILL.md"))).length;
const countMd = (dir: string) => entriesOf(dir).filter((e) => e.isFile() && e.name.endsWith(".md")).length;

/**
 * Plugins the CLI has installed, enabled or not: ~/.claude/plugins/installed_plugins.json
 * names each one's directory, ~/.claude/settings.json says which are on.
 */
export function installedPlugins(home: string = os.homedir()): InstalledPlugin[] {
  const enabled = readJson(path.join(home, ".claude", "settings.json"))?.enabledPlugins || {};
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const out: InstalledPlugin[] = [];
  for (const [key, entries] of Object.entries<any>(installed?.plugins || {})) {
    const entry = Array.isArray(entries) ? entries[0] : null;
    if (!entry?.installPath) continue;
    const [name, marketplace = ""] = key.split("@");
    out.push({
      id: key,
      name,
      marketplace,
      version: String(entry.version || ""),
      scope: entry.scope || "user",
      enabled: Boolean(enabled[key]),
      skills: countSkills(path.join(entry.installPath, "skills")),
      agents: countMd(path.join(entry.installPath, "agents")),
      commands: countMd(path.join(entry.installPath, "commands")),
      installPath: entry.installPath
    });
  }
  return out;
}

// Only claude has a plugin system this host can read; another engine gets none rather than claude's.
export function listPlugins(engine: string = "claude"): PluginItem[] {
  if (engine !== "claude") return [];
  return installedPlugins().map(({ installPath, ...item }) => item);
}
