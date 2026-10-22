import ts from "typescript";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const [configName, ...scopes] = process.argv.slice(2);
if (!configName || !scopes.length) throw new Error("Usage: inferMigrationTypes.mjs <tsconfig> <owned source paths...>");
const configPath = path.resolve(configName);
const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
const allowed = scopes.map((scope) => path.resolve(scope));
const owns = (file) => allowed.some((scope) => file === scope || file.startsWith(scope + path.sep));
const versions = new Map();
const host = {
  getScriptFileNames: () => parsed.fileNames,
  getScriptVersion: (file) => String(versions.get(file) || 0),
  getScriptSnapshot: (file) => ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(file)) : undefined,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
};
const service = ts.createLanguageService(host);
let count = 0;
for (const file of parsed.fileNames.filter((file) => owns(file) && /\.(ts|tsx|mts)$/.test(file) && !file.endsWith(".d.ts"))) {
  for (let round = 0; round < 100; round++) {
    let applied = false;
    for (const diagnostic of service.getSemanticDiagnostics(file)) {
      if (diagnostic.start === undefined) continue;
      const fixes = service.getCodeFixesAtPosition(file, diagnostic.start, diagnostic.start + (diagnostic.length || 0), [diagnostic.code], {
        indentSize: 2, tabSize: 2, convertTabsToSpaces: true,
      }, {});
      const fix = fixes.find((candidate) => candidate.fixName === "inferFromUsage" && candidate.changes.length && candidate.changes.every((change) => owns(change.fileName) && /\.(?:ts|tsx|mts)$/.test(change.fileName) && change.textChanges.every((edit) => !/\b(?:any|never)\b|@ts-(?:ignore|nocheck)|eslint-disable/.test(edit.newText))));
      if (!fix) continue;
      for (const change of fix.changes) {
        let text = readFileSync(change.fileName, "utf8");
        for (const edit of [...change.textChanges].sort((a, b) => b.span.start - a.span.start)) {
          text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
        }
        const syntax = ts.createSourceFile(change.fileName, text, ts.ScriptTarget.Latest, true);
        if (syntax.parseDiagnostics.length) throw new Error(`Compiler fix produced invalid syntax in ${change.fileName}; file was not written.`);
        writeFileSync(change.fileName, text);
        versions.set(change.fileName, (versions.get(change.fileName) || 0) + 1);
      }
      applied = true;
      count++;
      break;
    }
    if (!applied) break;
  }
}
service.dispose();
console.log(`Applied ${count} compiler type-inference fixes within the explicitly owned paths; review and typecheck the resulting diff.`);
