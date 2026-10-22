# Foundation decisions: stage 0

Baseline: `5ec709ed34757c4ef425682586e9e94e8d4571be` (`migrar-ts`, 2026-10-20). This file records stage-zero policy and evidence only; toolchain decisions for the actual migration belong to stage 1.

## Decisions

1. **Use TypeScript incrementally.** New and migrated product code uses `.ts` or `.tsx`. Existing JavaScript stays in place until its migration slice is ready. Build and tool configuration and the explicit exclusions in [exceptions.md](./exceptions.md) can remain JavaScript/MJS.
2. **Do not change runtime behavior in stage 0.** No source moves, package or compiler configuration changes are part of the stage-zero deliverable. Establish the baseline and dependency map first.
3. **Pin inventory inputs to a Git revision.** The auditor enumerates `git ls-files`, reads file contents with `git show <revision>:<path>`, and stores the source revision in its output. This prevents unrelated working-tree edits from changing the reported source metrics.
4. **Use the TypeScript compiler API for JSX inventory.** The auditor parses JavaScript with JSX enabled and JSX files as TSX. It records TypeScript version, parse diagnostics, per-file JSX node counts, and each local syntactic import/export/dynamic-import/require reference. See [inventory.md](./inventory.md) and its full machine-readable data in `inventory.json`.
5. **Treat import references as a review index, not a complete dependency graph.** Relative imports are resolved against tracked paths and common source extensions. Package imports, aliases, computed dynamic imports, and runtime string lookups cannot be established by this syntax-only scan; owners must inspect those when moving a slice.
6. **Test failures remain baseline observations.** Stage 0 does not change tests to make them green. Existing failures are listed in [validation.md](./validation.md) so later checks can distinguish them from migration regressions.

## Questions intentionally deferred to stage 1

- Exact TypeScript and `@types/*` versions in each app/package, install and lockfile policy, and supported Node versions for development tools.
- TypeScript configuration matrix and strictness flags for Node, tests, Preact, Next/React, Cloudflare Worker, service worker, Chrome extension, GitBook, Expo, and Tauri frontend.
- Test runner and host development execution for mixed JS/TS, including Node 18 compatibility and explicit `.js` import resolution.
- Output pipeline for TS used by host package/esbuild, Worker text injection, `/sw.js`, Chrome extension, and Tauri.
- Typecheck, test, lint, and local build scripts. These must cover each source runtime without making TypeScript a package runtime dependency.


## Stage 1 decisions implemented

- Toolchain: TypeScript `6.0.3`, tsx `4.20.6`, typescript-eslint `8.72.0`, Node types `18.19.130`, React 19 types `19.2.3`, Chrome types `0.3.5`. Expo keeps its React 18 declarations and TypeScript locally. Actual development runtime: Node `22.23.2`, npm `10.9.8`; host distribution target remains Node 18.
- Lockfiles retain the repository's ignored policy. Added direct toolchain dependencies use exact versions. `dependency-tree.json` records the resolved top-level workspace tree; this does not pin future transitive installations.
- All projects use `strict`, `allowJs`, `checkJs: false`, and `noEmit`. Unconverted JS remains a migration backlog. `skipLibCheck` applies only to external declaration checking, because OpenNext/Wrangler declarations combine incompatible runtime globals; it does not exempt maintained TS source from checking.
- Preserve explicit `.js` module specifiers where they already exist. tsx and esbuild resolve the corresponding TS source; Next/Webpack's actual static build passed this mixed-source spike. Template imports that enumerate locale files use `.ts` after the mechanical conversion. Host source commands and spawned development servers load tsx; distributed CJS entrypoints do not require tsx.
- Shared config paths must survive `web/.staticBuild`: `buildWebStatic.mjs` resolves a relative `extends` against the original `web/` before building its mirror.
- Tests use `node --import tsx --test` through `scripts/runTests.mjs`, recursively discovering test files. Tests migrate to `.ts`, with `.mts` reserved for ESM-specific cases. A deployed signaling test still needs explicit URL/session setup and is not evidence of a local unit-test pass.
- Browser assets compile before dev/build/static export. `web/workers/serviceWorker.ts` emits the classic `/sw.js` asset; `web/public/sw.js` remains a generated output. Worker injection scripts transpile TS before inlining. The injection fixture verifies valid JS, preserved replacement strings, and idempotence.
- Locale normalization uses the TypeScript AST to retain the first property insertion position and last assigned value for duplicate object keys. This removed 114 shadowed assignments. `verifyLocaleMigration.mjs <baseline>` compares the complete evaluated dictionaries and root key order; 47 modules preserve baseline values. There are no new translations.
- GitBook uses Webpack for the local build after the default Turbopack failed to resolve Next from the workspace. Generated content runs before typecheck/build. Expo remains an independent install.
- Tauri emits classic IIFEs at the original inline script positions, including the synchronous theme bootstrap. Its native build hook builds frontend assets without signing or publishing.
- JSON input types describe existing protocol expectations; they do not add validation or authorize untrusted values. Existing runtime checks remain in place. Narrow parse-boundary assertions and error-message projections must be reviewed with each slice.

### Configuration matrix

| Maintained sources | Configuration / command | Runtime and globals |
|---|---|---|
| Host server/CLI/features | `host/tsconfig.json` | NodeNext, Node 18 declarations |
| Host tests | `host/tsconfig.test.json` | NodeNext, node:test + imported sources |
| Host UI | `host/ui/tsconfig.json` | Bundler, DOM, Preact TSX |
| Chrome extension | `host/extension/tsconfig.json` | Browser/Chrome APIs |
| Web UI/Next | `web/tsconfig.json` | Bundler, DOM/React, Next generated route types |
| Web tests | `web/tsconfig.test.json` | NodeNext, Node test environment + imported sources |
| Worker APIs and injection sources | `web/tsconfig.worker.json` | Cloudflare Worker globals and explicit bindings |
| Service worker | `web/tsconfig.service-worker.json` | WebWorker globals, no DOM window |
| GitBook | `gitbook/tsconfig.json` | Next/React, alias and generated JSON |
| Expo | `expo/tsconfig.json` | Expo base, React Native/React 18 |
| Tauri frontend | `desktop/tsconfig.json` | DOM and narrow Tauri event bridge |

Root `npm run typecheck` aggregates the workspaces and standalone Expo. Native runtime validation remains separate from compiler coverage. Node 18 runner execution must still be demonstrated on an actual Node 18 binary; the current machine's default Node 22 alone is insufficient evidence.
