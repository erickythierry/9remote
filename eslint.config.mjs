import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx,mts}"],
  })),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/.staticBuild/**",
    "**/.open-next/**",
    "**/out/**",
    "**/dist/**",
    "**/build/**",
    "**/generated/**",
    "**/next-env.d.ts",
    "web/public/sw.js",
  ]),
]);

export default eslintConfig;
