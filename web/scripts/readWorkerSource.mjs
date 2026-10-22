import { readFileSync, existsSync } from "node:fs";
import { transformSync } from "esbuild";

export function readWorkerSource(jsPath) {
  const tsPath = jsPath.replace(/\.js$/, ".ts");
  if (!existsSync(tsPath)) return readFileSync(jsPath, "utf8");
  return transformSync(readFileSync(tsPath, "utf8"), {
    loader: "ts",
    target: "es2022",
    sourcefile: tsPath,
    legalComments: "none",
  }).code;
}
