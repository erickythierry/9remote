import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function readRuntimeSource(input) {
  const requested = input instanceof URL ? fileURLToPath(input) : input;
  const file = [requested, requested.replace(/\.jsx?$/, ".ts"), requested.replace(/\.jsx?$/, ".tsx")]
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`Source file not found: ${requested}`);
  const source = readFileSync(file, "utf8");
  if (!/\.(?:ts|tsx|mts)$/.test(file)) return source;
  return ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  }).outputText;
}
