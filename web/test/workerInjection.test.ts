import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

test("Worker injections compile TS, preserve replacement strings and remain idempotent", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "9remote-worker-injection-"));
  try {
    for (const directory of ["scripts", "durable-objects", ".open-next"]) {
      mkdirSync(path.join(temporary, directory));
    }
    symlinkSync(path.join(webRoot, "..", "node_modules"), path.join(temporary, "node_modules"), "dir");
    const files = ["scripts/readWorkerSource.mjs", "scripts/injectSignalingDO.mjs", "scripts/injectHotRoutes.mjs", "durable-objects/SignalingDO.ts", "hotRoutes.ts"];
    for (const file of files) copyFileSync(path.join(webRoot, file), path.join(temporary, file));
    const worker = path.join(temporary, ".open-next/worker.js");
    writeFileSync(worker, 'export default { async fetch(request, env) { const url = new URL(request.url); return new Response("fallback"); } };\n');
    const inject = () => {
      for (const file of ["injectSignalingDO.mjs", "injectHotRoutes.mjs"]) {
        execFileSync(process.execPath, [path.join(temporary, "scripts", file)], { stdio: "pipe" });
      }
    };
    inject();
    const first = readFileSync(worker, "utf8");
    assert.match(first, /class SignalingDO extends DurableObject/);
    assert.match(first, /async function sessionHeartbeat/);
    assert.match(first, /handleHotRoutes\(request, env\)/);
    assert.match(first, /"\$1"/);
    assert.doesNotThrow(() => transformSync(first, { loader: "js", target: "es2022" }));
    inject();
    assert.equal(readFileSync(worker, "utf8"), first);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
