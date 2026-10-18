// Reads the env and --settings a custom launcher (a wrapper script) hands to `claude`.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { splitCommand } from "../terminal/customAgents.js";
import { getExtendedEnv } from "./adapters/env.js";
import { AI_MODEL_CACHE_TTL_MS } from "./constants.js";

const PROBE_TIMEOUT_MS = 5000;

// The wrapper's `exec claude ...` lands on this stub, which prints what it was given.
const STUB_SOURCE = `#!/bin/sh\nexec "${process.execPath}" -e 'process.stdout.write(JSON.stringify({env:process.env,args:process.argv.slice(1)}))' -- "$@"\n`;

const cache = new Map();

function parseSettingsArg(args) {
  const at = args.indexOf("--settings");
  const value = at === -1 ? "" : args[at + 1] || "";
  if (!value) return {};
  try {
    return JSON.parse(value.trim().startsWith("{") ? value : fs.readFileSync(value, "utf8"));
  } catch {
    return {};
  }
}

function runProbe(launcher) {
  const { bin, args } = splitCommand(launcher);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "claude"), STUB_SOURCE, { mode: 0o755 });
    const env = getExtendedEnv();
    env.PATH = `${dir}${path.delimiter}${env.PATH}`;
    const res = spawnSync(bin, args, { env, encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (res.status !== 0) return null;
    const out = JSON.parse(res.stdout.trim().split("\n").pop());
    return { env: out.env || {}, settings: parseSettingsArg(out.args || []) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `{ env, settings }` the launcher passes to claude, or null (no launcher, Windows, or it never reaches claude). */
export function probeLauncher(launcher) {
  if (!launcher || process.platform === "win32") return null;
  const hit = cache.get(launcher);
  if (hit && Date.now() - hit.at < AI_MODEL_CACHE_TTL_MS) return hit.result;
  const result = runProbe(launcher);
  cache.set(launcher, { at: Date.now(), result });
  return result;
}
