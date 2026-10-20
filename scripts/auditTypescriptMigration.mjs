#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const outputDir = path.join(repoRoot, "docs/typescript-migration");
const shouldWrite = process.argv.includes("--write");

let ts;
try {
  ts = require("typescript");
} catch {
  console.error("TypeScript is required for AST parsing. Install it in the workspace before running this audit.");
  process.exit(2);
}

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trimEnd();
const revision = git(["rev-parse", "HEAD"]);
const trackedFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const counts = new Map();
const jsxFiles = [];
const parseErrors = [];
const references = [];
const sourceFiles = trackedFiles.filter((file) => sourceExtensions.has(path.extname(file)));
const trackedSources = new Set(sourceFiles);
const consumerExts = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json"];
const inlineExceptions = ["desktop/dist/index.html", "host/ui/index.html"];

function exceptionFor(file) {
  if (/^(scripts|host\/scripts|web\/scripts|gitbook\/scripts|desktop\/scripts)\//.test(file) || file === "host/cli/scripts/install.js") {
    return { reason: "Build, release, packaging, or generated-content automation remains JavaScript tooling.", status: "permanent", reviewer: "migration coordinator" };
  }
  if (file.startsWith("host/benchmark/")) {
    return { reason: "Existing benchmark harnesses are explicitly excluded from source conversion.", status: "permanent", reviewer: "migration coordinator" };
  }
  if (/^web\/test\/loader-alias[^/]*\.mjs$/.test(file)) {
    return { reason: "Custom Node test loaders remain MJS while the test execution strategy is selected.", status: "temporary", reviewer: "migration coordinator" };
  }
  if (["eslint.config.mjs", "host/vite.config.js", "host/tailwind.config.js", "host/postcss.config.js", "web/next.config.mjs", "web/postcss.config.mjs", "gitbook/next.config.mjs", "gitbook/postcss.config.mjs", "expo/babel.config.js", "expo/metro.config.js"].includes(file)) {
    return { reason: "Tool configuration is kept in the format loaded directly by its tool.", status: "permanent", reviewer: "migration coordinator" };
  }
  return null;
}

function areaOf(file) {
  const first = file.split("/")[0];
  return ["host", "web", "gitbook", "expo", "scripts", "desktop"].includes(first) ? first : "root";
}

function addCount(area, extension, property) {
  const key = `${area}\0${extension}`;
  const row = counts.get(key) ?? { area, extension, files: 0, withJsx: 0 };
  row[property] += 1;
  counts.set(key, row);
}

function scriptKind(file) {
  const extension = path.extname(file);
  if (extension === ".tsx" || extension === ".jsx") return ts.ScriptKind.TSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function jsxCount(sourceFile) {
  let count = 0;
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function resolveReference(consumer, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(consumer), specifier));
  const candidates = [base];
  if (!path.posix.extname(base)) candidates.push(...consumerExts.map((ext) => `${base}${ext}`));
  else {
    const ext = path.posix.extname(base);
    const stem = base.slice(0, -ext.length);
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) candidates.push(...[".ts", ".tsx", ".mts", ".cts"].map((next) => `${stem}${next}`));
    if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) candidates.push(...[".js", ".jsx", ".mjs", ".cjs"].map((next) => `${stem}${next}`));
  }
  const resolved = candidates.find((candidate) => trackedSources.has(candidate) || trackedFiles.includes(candidate));
  return { resolved: resolved ?? null, candidates: resolved ? undefined : candidates };
}

function recordReference(consumer, node, specifier) {
  const result = resolveReference(consumer, specifier);
  if (!result) return;
  references.push({ consumer, line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1, specifier, ...result });
}

for (const file of trackedFiles) {
  const extension = path.extname(file);
  if (!sourceExtensions.has(extension)) continue;
  addCount(areaOf(file), extension, "files");
  let text;
  try {
    text = git(["show", `HEAD:${file}`]);
  } catch (error) {
    parseErrors.push({ file, error: `git show failed: ${error.message}` });
    continue;
  }
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  if (sourceFile.parseDiagnostics.length) {
    for (const diagnostic of sourceFile.parseDiagnostics) {
      const pos = diagnostic.start ?? 0;
      const location = sourceFile.getLineAndCharacterOfPosition(pos);
      parseErrors.push({ file, line: location.line + 1, column: location.character + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
    }
  }
  const nJsx = jsxCount(sourceFile);
  if (nJsx) {
    jsxFiles.push({ file, extension, jsxNodes: nJsx });
    addCount(areaOf(file), extension, "withJsx");
  }
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      recordReference(file, node, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const expression = node.expression;
      const isImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(expression) && expression.text === "require";
      if (isImport || isRequire) recordReference(file, node, node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const rows = [...counts.values()].sort((a, b) => a.area.localeCompare(b.area) || a.extension.localeCompare(b.extension));
const refsByTarget = new Map();
for (const reference of references) {
  const target = reference.resolved ?? `(unresolved) ${reference.specifier}`;
  const list = refsByTarget.get(target) ?? [];
  list.push(reference);
  refsByTarget.set(target, list);
}
const jsxTotals = jsxFiles.reduce((acc, entry) => {
  acc[entry.extension] = (acc[entry.extension] ?? 0) + 1;
  acc.total += 1;
  return acc;
}, { total: 0 });
const exceptions = [
  ...sourceFiles.flatMap((file) => {
    const exception = exceptionFor(file);
    return exception ? [{ file, ...exception }] : [];
  }),
  ...inlineExceptions.filter((file) => trackedFiles.includes(file)).map((file) => ({
    file,
    reason: "Inline bootstrap is retained because extraction may change pre-render timing; reassess during the desktop and host UI migration stage.",
    status: "temporary",
    reviewer: "migration coordinator",
  })),
].sort((a, b) => a.file.localeCompare(b.file));

const report = {
  schemaVersion: 1,
  revision,
  fileSelection: "git ls-files -z at HEAD; content parsed from git show HEAD:<path>",
  parser: { package: "typescript", version: ts.version, api: "createSourceFile + TypeScript AST", scriptKinds: { js: "JSX", jsx: "TSX", tsx: "TSX", mjs: "JSX", other: "TS" } },
  totals: { trackedFiles: trackedFiles.length, sourceFiles: sourceFiles.length, references: references.length, jsxFiles: jsxTotals.total, parseErrors: parseErrors.length },
  counts: rows,
  jsxFiles: jsxFiles.sort((a, b) => a.file.localeCompare(b.file)),
  exceptions,
  consumerReferences: references.sort((a, b) => a.resolved?.localeCompare(b.resolved ?? "") || a.consumer.localeCompare(b.consumer) || a.line - b.line),
  consumersByTarget: Object.fromEntries([...refsByTarget.entries()].sort(([a], [b]) => a.localeCompare(b))),
  parseErrors,
};

const markdown = [
  "# Tracked source inventory",
  "",
  `Baseline revision: \`${revision}\`.`,
  "",
  "Generated from files tracked by Git at that revision. Source contents are read from the same commit, so working-tree edits do not silently change the reported baseline.",
  "",
  `Command: \`node scripts/auditTypescriptMigration.mjs --write\` (TypeScript ${ts.version}, compiler API AST parsing; JSX enabled for JavaScript and JSX extensions).`,
  "",
  `Tracked files: ${trackedFiles.length}; source modules: ${sourceFiles.length}; local consumer references: ${references.length}; AST parse errors: ${parseErrors.length}.`,
  "",
  `JSX-bearing files: ${jsxTotals.total} total (${jsxTotals[".js"] ?? 0} .js, ${jsxTotals[".jsx"] ?? 0} .jsx, ${jsxTotals[".mjs"] ?? 0} .mjs, ${jsxTotals[".ts"] ?? 0} .ts, ${jsxTotals[".tsx"] ?? 0} .tsx).`,
  "",
  "## Counts by area and extension",
  "",
  "| Area | Extension | Files | With JSX |",
  "|---|---:|---:|---:|",
  ...rows.map((row) => `| ${row.area} | \`${row.extension}\` | ${row.files} | ${row.withJsx} |`),
  "",
  "## Consumer reference data",
  "",
  "`inventory.json` contains each local import/export/dynamic-import/require reference, its source line, and the tracked target it resolves to. Bare package and alias imports are omitted; references that could not be matched to a tracked file remain listed with candidate paths. This is a reproducible syntactic index, not a semantic dependency graph.",
  "",
  "## Stage 0 exceptions",
  "",
  "This is the complete path-level exception registry recognized by the audit at the baseline revision. Status, reason, and review owner are also stored as structured fields in `inventory.json`.",
  "",
  "| Path | Status | Reason | Review owner |",
  "|---|---|---|---|",
  ...exceptions.map((exception) => `| \`${exception.file}\` | ${exception.status} | ${exception.reason} | ${exception.reviewer} |`),
  "",
  `AST diagnostics: ${parseErrors.length ? "see inventory.json" : "none"}.`,
  "",
].join("\n");

if (shouldWrite) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "inventory.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDir, "inventory.md"), markdown);
} else {
  process.stdout.write(markdown);
}
if (parseErrors.length) process.exitCode = 1;
