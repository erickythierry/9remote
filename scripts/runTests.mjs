import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = new Set(["host", "web"]);
const target = process.argv[2];
if (!packages.has(target)) throw new Error("Expected test target: host or web");
const cwd = path.join(root, target);
function findTests(directory) {
  return readdirSync(path.join(cwd, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTests(relative);
    return /\.test\.(?:mjs|mts|ts|js)$/.test(entry.name) ? [relative] : [];
  });
}
const files = findTests("test").sort();
if (!files.length) throw new Error(`No tests found for ${target}`);
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${loader}`].filter(Boolean).join(" ");
const timeout = Number(process.versions.node.split(".")[0]) >= 22 ? ["--test-timeout=120000"] : [];
const result = spawnSync(process.execPath, ["--test", ...timeout, ...process.argv.slice(3), ...files], {
  cwd,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`Tests terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
