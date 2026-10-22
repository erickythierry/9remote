import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = process.argv[2];
if (!revision || revision.startsWith("-")) throw new Error("Provide the baseline Git revision");
const directories = ["web/shared/i18n/locales", "host/ui/src/i18n/locales"];
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", ...directories], {
  cwd: root,
  encoding: "utf8",
}).trim().split("\n").filter((file) => file.endsWith(".js"));
assert.ok(files.length, "Baseline must contain locale modules");
for (const file of files) {
  const source = execFileSync("git", ["show", `${revision}:${file}`], { cwd: root });
  const current = readFileSync(path.join(root, file.replace(/\.js$/, ".ts")), "utf8");
  if (path.basename(file) === "index.js") {
    assert.equal(current, source.toString(), file);
  } else {
    const baselineModule = await import(`data:text/javascript;base64,${source.toString("base64")}`);
    const js = ts.transpileModule(current, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
    const migratedModule = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
    assert.deepEqual(migratedModule.default, baselineModule.default, file);
    assert.deepEqual(Object.keys(migratedModule.default), Object.keys(baselineModule.default), `${file}: key order`);
  }
  assert.equal(existsSync(path.join(root, file)), false, `Old source remains: ${file}`);
}
console.log(`${files.length} locale modules preserve baseline keys and values.`);
