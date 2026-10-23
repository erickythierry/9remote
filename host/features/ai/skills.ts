import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installedPlugins } from "./plugins.js";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  path: string;
  source: "user" | "project" | "plugin";
  plugin?: string;
  userOnly?: boolean;
}

interface CachedSkills {
  at: number;
  [key: string]: SkillItem[] | number | null;
}

let cachedSkills: CachedSkills = { claude: null, codex: null, at: 0 };
const CACHE_TTL_MS = 10000;

function parseSkillMd(mdPath: string, fallbackName: string): { name: string; description: string; userOnly: boolean } {
  try {
    const content = fs.readFileSync(mdPath, "utf8");
    const match = content.match(/^---\s*([\s\S]*?)\s*---/);
    let name = fallbackName;
    let description = `Skill: ${fallbackName}`;
    let userOnly = false;
    if (match) {
      const yaml = match[1];
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      // The value runs to the next top-level key (hyphens allowed) or the end; a `>`/`|` block marker is not text.
      const descMatch = yaml.match(/^description:\s*([\s\S]*?)(?=\n[A-Za-z_-]+:|(?![\s\S]))/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].replace(/^[>|][-+]?/, "").trim().replace(/\s+/g, " ");
      userOnly = /^disable-model-invocation:\s*true\s*$/m.test(yaml);
    }
    return { name, description, userOnly };
  } catch {
    return { name: fallbackName, description: `Skill: ${fallbackName}`, userOnly: false };
  }
}

// A skill may be a symlink to a directory (omarchy ships its skills that way), which Dirent.isDirectory() reports as false.
const isDir = (p: string) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

// requireMd: a plugin's skills/ also holds build files and folders that are not skills.
function scanSkillDir(baseDir: string, source: SkillItem["source"], plugin?: string, requireMd = false): SkillItem[] {
  if (!fs.existsSync(baseDir)) return [];
  const results: SkillItem[] = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const skillPath = path.join(baseDir, entry.name);
      if (entry.name.startsWith(".") || !isDir(skillPath)) continue;
      const mdPath = path.join(skillPath, "SKILL.md");
      if (requireMd && !fs.existsSync(mdPath)) continue;
      const { name, description, userOnly } = parseSkillMd(mdPath, entry.name);
      // The CLI names a plugin's skill `<plugin>:<name>`, and that is what a prompt must type.
      const qualified = plugin ? `${plugin}:${name}` : name;
      results.push({
        id: plugin ? `${plugin}:${entry.name}` : entry.name,
        name: qualified,
        description,
        path: skillPath,
        source,
        ...(plugin ? { plugin } : {}),
        ...(userOnly ? { userOnly } : {})
      });
    }
  } catch {}
  return results;
}

export function listSkills(engine: string = "claude", workspacePath: string | null = null): SkillItem[] {
  const now = Date.now();
  if (cachedSkills[engine] && now - cachedSkills.at < CACHE_TTL_MS) {
    return cachedSkills[engine] as SkillItem[];
  }

  const home = os.homedir();
  // Each engine reads where IT keeps skills — every path below was found on disk, not
  // inferred. The old shape was `codex ? codex-dir : claude-dir`, so opencode and
  // antigravity were shown claude's library as if it were theirs: 18 rows of another
  // CLI's skills, in a modal that offers them as things this engine can run.
  const dirs = skillDirs(engine, home, workspacePath);

  const map = new Map<string, SkillItem>();
  for (const dir of dirs) {
    const source = workspacePath && dir.startsWith(workspacePath + path.sep) ? "project" : "user";
    for (const s of scanSkillDir(dir, source)) {
      if (!map.has(s.id)) map.set(s.id, s);
    }
  }
  // Only claude has plugins this host can read.
  if (engine === "claude") {
    for (const plugin of installedPlugins(home).filter((p) => p.enabled)) {
      for (const s of scanSkillDir(path.join(plugin.installPath, "skills"), "plugin", plugin.name, true)) {
        if (!map.has(s.id)) map.set(s.id, s);
      }
    }
  }

  const list = Array.from(map.values());
  cachedSkills[engine] = list;
  cachedSkills.at = now;
  return list;
}

/** Every place one engine reads skills from, most specific last. */
// Engine → its skill directories, most specific last; an engine nobody has taught gets
// no library rather than another engine's.
const SKILL_DIRS: Record<string, (home: string, workspacePath?: string | null) => string[]> = {
  codex: (home) => [path.join(home, ".codex", "skills")],
  opencode: (home) => [path.join(home, ".config", "opencode", "skills")],
  // Both are real: the user's own library and the CLI's shipped ones.
  antigravity: (home) => [
    path.join(home, ".gemini", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "builtin", "skills")
  ],
  claude: (home, workspacePath) => [
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", "skills copy"),
    ...(workspacePath ? [path.join(workspacePath, ".claude", "skills")] : [])
  ],
  // Hermes resolves skills only from its home (tools/skills_tool.py: "all
  // skills live in ~/.hermes/skills/") — no workspace-level library exists.
  hermes: (home) => [path.join(home, ".hermes", "skills")],
  // pi mirrors claude: user-level library plus the project's own.
  pi: (home, workspacePath) => [
    path.join(home, ".pi", "agent", "skills"),
    ...(workspacePath ? [path.join(workspacePath, ".pi", "agent", "skills")] : [])
  ]
};

export function skillDirs(engine: string, home: string, workspacePath?: string | null): string[] {
  return SKILL_DIRS[engine]?.(home, workspacePath) || [];
}
