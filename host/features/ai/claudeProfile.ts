import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeLauncher } from "./launcherProbe.js";
import { customAgentList } from "../terminal/customAgents.js";

const defaultDir = () => path.join(os.homedir(), ".claude");
const PROFILE_DIR_RE = /^\.claude-[\w.-]+$/;
// What the CLI creates inside a config dir on first use; a bare `.claude-*` folder without them is not a profile.
const PROFILE_MARKERS = ["projects", "settings.json", ".claude.json"];

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isProfile = (dir: string) => PROFILE_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));

// Profiles a launcher revealed, kept so a profile outside ~/.claude-* is still found once its launcher ran.
const learned = new Set<string>();

// A launcher can export CLAUDE_CONFIG_DIR (a separate profile); the CLI then reads everything from there.
export function claudeConfigDir(launcher: string = ""): string {
  const fromLauncher = probeLauncher(launcher)?.env.CLAUDE_CONFIG_DIR;
  if (fromLauncher) {
    const dir = path.resolve(fromLauncher);
    if (!learned.has(dir)) { learned.add(dir); scan = null; }
    return dir;
  }
  return process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : defaultDir();
}

// The CLI keeps .claude.json inside a custom profile dir, but beside it (in $HOME) for the default one.
export function claudeStateFile(configDir: string): string {
  const beside = path.join(os.homedir(), ".claude.json");
  const inside = path.join(configDir, ".claude.json");
  if (configDir !== defaultDir()) return inside;
  return !fs.existsSync(beside) && fs.existsSync(inside) ? inside : beside;
}

/** Runs each Claude launcher once so the profile it points at is known before any reader asks. */
export function learnLauncherProfiles(): void {
  for (const agent of customAgentList()) {
    if (agent.base === "claude") claudeConfigDir(agent.cmd);
  }
}

// Readers poll this on every transcript lookup; a profile created a moment ago can wait for the next window.
const PROFILE_SCAN_TTL_MS = 5000;
let scan: { at: number; home: string; dirs: string[] } | null = null;

/** Every Claude Code profile on this machine, default first: ~/.claude, $CLAUDE_CONFIG_DIR, ~/.claude-*, and launcher profiles seen so far. */
export function claudeProfileDirs(): string[] {
  const home = os.homedir();
  if (scan && scan.home === home && Date.now() - scan.at < PROFILE_SCAN_TTL_MS) return [...scan.dirs];
  const found = [defaultDir()];
  if (process.env.CLAUDE_CONFIG_DIR) found.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  found.push(...learned);
  let entries: string[] = [];
  try { entries = fs.readdirSync(home); } catch {}
  for (const name of entries.sort()) {
    const dir = path.join(home, name);
    if (PROFILE_DIR_RE.test(name) && isDir(dir) && isProfile(dir)) found.push(dir);
  }
  const dirs = [...new Set(found)].filter((dir, i) => i === 0 || isDir(dir));
  scan = { at: Date.now(), home, dirs };
  return [...dirs];
}

/** `projects/` of every profile; the launcher's own profile comes first so a hit there costs one lookup. */
export function claudeProjectsDirs(launcher: string = ""): string[] {
  const dirs = claudeProfileDirs();
  if (launcher) dirs.unshift(claudeConfigDir(launcher));
  return [...new Set(dirs)].map((dir) => path.join(dir, "projects"));
}

const isInside = (target: string, root: string) => target === root || target.startsWith(root + path.sep);

/** The profile dir a transcript file lives under, or null. */
export function profileOfTranscript(filePath: string): string | null {
  const file = path.resolve(filePath);
  return claudeProfileDirs().find((dir) => isInside(file, path.resolve(dir, "projects"))) ?? null;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Points a `claude --resume ...` line at the profile that owns the session: its launcher when one is registered, else CLAUDE_CONFIG_DIR. */
export function resumeLineForProfile(line: string, configDir: string | null): string {
  if (!configDir || path.resolve(configDir) === claudeConfigDir()) return line;
  const launcher = customAgentList().find((a) => a.base === "claude" && claudeConfigDir(a.cmd) === path.resolve(configDir));
  if (launcher) return line.startsWith("claude") ? launcher.cmd + line.slice("claude".length) : line;
  return process.platform === "win32" ? line : `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ${line}`;
}
