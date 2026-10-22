import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [revision, ...scopes] = process.argv.slice(2);
if (!revision || revision.startsWith("-") || !scopes.length) throw new Error("Usage: checkMigrationSemantics.mjs <baseline revision> <owned paths...>");
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", ...scopes], { encoding: "utf8" }).trim().split("\n");
const changes = [];
let identical = 0;
function compile(source, file) {
  return ts.transpileModule(source, {
    fileName: file.replace(/\.jsx?$/, ".tsx"),
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: file.startsWith("host/ui/") ? "preact" : "react",
      removeComments: true,
    },
  }).outputText;
}
for (const file of files.filter((file) => /\.jsx?$/.test(file))) {
  const migrated = [file.replace(/\.jsx?$/, ".ts"), file.replace(/\.jsx?$/, ".tsx")].find((candidate) => existsSync(candidate));
  if (!migrated) continue;
  const baseline = execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" });
  if (compile(baseline, file) === compile(readFileSync(migrated, "utf8"), file)) identical++;
  else changes.push({ baseline: file, migrated });
}
const output = "docs/typescript-migration/semantics-review.json";
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ revision, scopes, identical, requiresReview: changes }, null, 2) + "\n");
console.log(`${identical} modules have identical JavaScript after type erasure; ${changes.length} need manual runtime-diff review. Report: ${output}`);
// Differences include necessary path/typing adaptations; this report is a review index, not proof of behavior parity.
