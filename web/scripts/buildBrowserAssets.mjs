import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("../workers/serviceWorker.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../public/sw.js", import.meta.url)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
});
