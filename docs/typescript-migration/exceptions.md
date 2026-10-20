# JavaScript and inline-code exceptions

Baseline: `5ec709ed34757c4ef425682586e9e94e8d4571be`. The policy is that JavaScript/MJS is permitted only for the categories below or an individually reviewed file. Every currently recognized file is listed with reason, review owner, and temporary/permanent status in the **Stage 0 exceptions** table in [inventory.md](./inventory.md) and in the `exceptions` array of [inventory.json](./inventory.json). Regenerate that list with `node scripts/auditTypescriptMigration.mjs --write` after the TypeScript compiler API is installed.

| Category | Scope | Status | Review owner |
|---|---|---|---|
| Build, release, packaging, and generated-content automation | `scripts/`, package-local `scripts/`, and `host/cli/scripts/install.js` | Permanent | Migration coordinator |
| Benchmarks | `host/benchmark/` | Permanent | Migration coordinator |
| Tool configuration | The exact ESLint, Vite, Tailwind, PostCSS, Next, Babel, and Metro files enumerated in `inventory.json` | Permanent | Migration coordinator |
| Custom Node test loaders | `web/test/loader-alias.mjs`, `web/test/loader-alias-hooks.mjs` | Temporary pending stage-1 runner decision | Migration coordinator |
| Inline pre-render bootstraps | `desktop/dist/index.html`, `host/ui/index.html` | Temporary pending a timing-preserving extraction review | Migration coordinator |

The three `host/extension/` scripts, locale modules, product configuration modules, all product modules, and test modules are **not** exceptions: they remain in migration scope. Generated JavaScript output is not treated as a source exception; the build must emit the runtime-required JS paths from TypeScript sources where the PRD requires conversion.

The auditor registry is deliberately explicit. If a new file must remain JavaScript/MJS, add a path-specific reason and status to the auditor and update this document. Do not widen a category silently. Temporary entries need a closeout decision at stage 7; no temporary entry is approved indefinitely by this baseline.

