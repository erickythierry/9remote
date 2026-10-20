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

