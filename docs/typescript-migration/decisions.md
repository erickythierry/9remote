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

