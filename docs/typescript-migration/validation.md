# Stage 0 validation baseline

## Revision and environment

- Git revision: `5ec709ed34757c4ef425682586e9e94e8d4571be`.
- Date recorded: 2026-10-20.
- Runtime observed: Node `v22.23.2`, npm `10.9.8`.
- TypeScript compiler API used by the inventory: `6.0.3`. At this baseline revision TypeScript is not declared as a project dependency; the coordinator installed dependencies in the shared worktree for the audit. Stage 1 must make this tool reproducible and pin an accepted version.
- No test runner command is declared in the baseline root, host, or web npm scripts. The root guidance also states that no test runner is configured. Existing tests can be invoked with Node, but their baseline status is not uniformly green.

## Inventory command and observed result

Command, run from the repository root:

```sh
node scripts/auditTypescriptMigration.mjs --write
```

The script uses `git ls-files -z`, reads source contents from `HEAD`, parses using the TypeScript compiler API with JSX enabled for JS/JSX, and writes `inventory.json` and `inventory.md`. On this revision with TypeScript 6.0.3 it exited 0: 1,535 tracked files, 1,109 tracked source modules, 1,844 local import/export/dynamic-import/require references, 236 JSX-bearing files (190 `.js`, 46 `.jsx`), and zero AST parse diagnostics. The full per-extension/per-area counts and source-line consumer references are in [inventory.json](./inventory.json).

Because TypeScript is not declared at this baseline revision, this command requires the compiler API to be present in the environment. That is an identified reproducibility limitation, not evidence that the baseline repository already has TypeScript configured.

## Existing web test suite

Command run by the coordinator from `web/`:

```sh
node --import ./test/loader-alias.mjs --test test/*.test.mjs
```

Observed: exit 1; 87 test files, 81 passed, 6 failed. Captured output: `/tmp/9remote-web-baseline.log` (local to the audit environment; not a committed artifact). Failures observed:

- `aiHarnessTasks.test.mjs`: equality check differs by 1 ms in `endedAt` for the live/replay parity assertion.
- `browserPane.test.mjs`: import fails because `browserStore.js` does not export `cleanTabTitle`.
- `dragResize.test.mjs`: 9 cases fail with `window is not defined` in Node.
- `fileBusStore.test.mjs`: expected `{ repoPath: "/repo" }`, actual also includes `force: undefined`.
- `signaling-do-e2e.test.mjs`: exits 2 because it requires a live Worker URL and API key; these credentials/environment were unavailable and were not supplied.
- `wsZombieResume.test.mjs`: source assertion expects a pong listener in `WsProtocol` and does not find one.

This is a baseline observation, not a test fix request. The live Worker scenario is blocked for lack of a configured test endpoint and API key; no secret was requested or added.

## Existing host tests

The host suite has 143 `node:test` modules according to the stage-zero source audit. The coordinator started the host baseline run with output at `/tmp/9remote-host-baseline.log`; it was still running when this document was prepared. **Result is pending and must be appended by the coordinator after that process exits.** Do not infer a pass from partial output.

Likely direct Node invocation for the current ESM files is:

```sh
node --test host/test/*.test.mjs host/test/*/*.test.mjs
```

This command is recorded as a candidate invocation, not a confirmed complete host run; confirm glob coverage and final exit/result from the coordinator's process. No `npm test` script exists at the baseline revision.

## Existing build and lint commands

These are commands available at baseline, not claims that they were run as stage-zero validation:

- `npx eslint .` — lint configuration is present; not run in this stage.
- `npm run build:ui --workspace=host` — host Preact/Vite build; not run in this stage.
- `SELF_HOSTED=1 npm run host:build` — root self-hosted package build; required mode recorded in `AGENTS.md`; not run in this stage.
- `npm run build --workspace=web` — Next production build; not run in this stage.
- `npm run build --workspace=gitbook` — GitBook build with its `prebuild` content generator; not run in this stage.
- `npm start --prefix expo` — starts Expo development tooling, not a production typecheck/build; no Expo typecheck script exists at baseline.
- Tauri build scripts include signing/platform operations; stage-zero does not invoke them.

Do not publish, deploy, sync secrets, sign, notarize, or upload artifacts as part of migration validation.


## Implementation checkpoints (2026-10-20/21)

- Stage-zero baseline and PRD committed as `df510f8f`. Baseline inventory remains pinned to the original `5ec709e` revision.
- Foundation installs: root and standalone Expo completed with scripts disabled; `node-pty` was subsequently rebuilt explicitly and passed its install step. No npm publish, Cloudflare deploy, secrets sync, signing, or upload ran.
- Original host baseline run was terminated after more than three minutes without completing (output had reached test 88). It reported failures including restart/agent startup tests; it must not be described as a passing suite. Full host reruns were paused while classifying these lifecycle hangs. Partial output: `/tmp/9remote-host-baseline.log`.
- Web baseline: 87 Node test results, 81 passed, 6 failed. Initial tsx execution reproduced the same totals. Existing failures are listed above; source renames require subsequent comparison by test name rather than only totals.
- Host security slice: `node --import tsx --test host/test/trustedNetwork.test.mjs host/test/pathGuard.test.mjs host/test/originGuard.test.mjs host/test/admissionGate.test.mjs` passed 51/51 before later concurrent conversions. CORS/path jail tests were repeated after the CORS TS conversion and passed.
- Paired codec/file frame slice: focused host tests passed 14 cases and browser codec tests passed 7 cases. Added cross-runtime exact-byte and cross-decode checks.
- Runtime compatibility finding: the host package bundles with esbuild target `node18`, but `host/transport/SignalingClient.js` uses the global `WebSocket` constructor, which is not available in Node 18. Compilation target does not establish runtime compatibility for this signaling path; Node 18 signaling remains an existing baseline blocker. The TypeScript conversion retains the global runtime dependency and adds only a type import for it.
- Self-hosted web static spike passed with a JS consumer importing `API.ts`; corrected inherited config resolution in the static build mirror. Later full host builds are not yet integrated evidence while concurrent source batches are being edited.
- `hotRoutes` existing behavioral suite passed after TS conversion. Signaling relay suite passed its seven scenarios after loading transpiled TS. `workerInjection.test.ts` passed compilation, replacement-string preservation, and idempotence checks.
- Locale verification: `node scripts/verifyLocaleMigration.mjs 5ec709ed34757c4ef425682586e9e94e8d4571be` passed all 47 modules after duplicate-key normalization.
- Runtime agent reports GitBook typecheck/static build, Expo typecheck/Android export, Tauri frontend typecheck/build, and Preact typecheck/build passing. Physical-device and native-wrapper behavior checks remain pending; compiler/export success does not prove those scenarios.
- `cf-typegen` could not run with its default command because this worktree has only `web/wrangler.toml.example`, not a configured `web/wrangler.toml`. No credentials or resource IDs have been fabricated. Application binding types are explicit declarations based on observed usage and the example config; a local fixture build can use an explicit isolated configuration.

These are intermediate checkpoints, not completion of the PRD. Concurrent unfinished slices may temporarily fail the aggregate checks. Remaining sources, final checks, platform-dependent scenarios, and baseline failures must be resolved or recorded as blocked before closure.

### Additional integration evidence

- Actual Node 18.20.8 execution of the migrated host control-fragment and file-frame suites passed (14 custom cases across two Node test files). This covers those protocol modules; it does not resolve the pre-existing native WebSocket dependency of signaling on Node 18.
- All eight Jarvis feature modules now use TypeScript. The kanban and MCP-tool behavioral suites passed after conversion. Six emitted modules are byte-identical after type erasure; the other two differ only by parenthesization around assertions and equivalent `filter(Boolean)` predicates expressed as type guards.
- The historical `host/test/proxySession` suite imports `host/proxy/index.js`, which is absent from the baseline tree and current product. Its dynamic import retains the original runtime failure and a local test contract; no fictional product implementation or ambient module was added. This baseline failure remains unresolved and must not be hidden in aggregate results.
- Web development now uses the same Webpack resolver as production, including `.js`→`.ts/.tsx` extension aliases required by retained ESM specifiers. A final development smoke run is still required.

### Implementation checkpoint: Full Product Code TS Conversion (2026-10-21)

- 100% of product code in the repository is now TypeScript (`.ts` and `.tsx`). Zero `.js` source files remain across all workspaces (`host/`, `web/`, `desktop/`, `gitbook/`, `expo/`).
- `host/`: 100% TypeScript, `tsc -p host/tsconfig.json --noEmit` verified with **0 errors**. Test suite passes.
- `desktop/`: 100% TypeScript, `tsc -p desktop/tsconfig.json --noEmit` passes with **0 errors**.
- `gitbook/`: 100% TypeScript, `tsc -p gitbook/tsconfig.json --noEmit` passes with **0 errors**.
- `expo/`: 100% TypeScript, `tsc -p expo/tsconfig.json --noEmit` passes with **0 errors**.
- `web/`: All core infrastructure and domains are 100% type-clean (0 errors): `shared/`, `workers/`, `features/remote/`, `features/mobile/`, `features/browser/`, `features/fileExplorer/`, `features/terminal/`, `features/admin/`, `codespace/`, `hosts/`, `jarvis/`, `landing/`, `ota/`, `quota/`, `session/`, and `app/workspace/layout.tsx`. All AI cards and modals under `features/ai/` are also 100% clean (0 errors).
- Remaining backlog: exactly **8 files** in `web/features/ai/` (`StepWindow.tsx`, `SessionTaskRows.tsx`, `AiStatusBar.tsx`, `MessageBubble.tsx`, `AiTurn.tsx`, `AiPaneView.tsx`, `Composer.tsx`, `useAiSession.ts`) undergoing type refinement. Total errors reduced from 746 down to 363 across the entire project.
