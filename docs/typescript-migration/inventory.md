# Tracked source inventory

Baseline revision: `5ec709ed34757c4ef425682586e9e94e8d4571be`.

Generated from files tracked by Git at that revision. Source contents are read from the same commit, so working-tree edits do not silently change the reported baseline.

Command: `node scripts/auditTypescriptMigration.mjs --write` (TypeScript 6.0.3, compiler API AST parsing; JSX enabled for JavaScript and JSX extensions).

Tracked files: 1535; source modules: 1109; local consumer references: 1844; AST parse errors: 0.

JSX-bearing files: 236 total (190 .js, 46 .jsx, 0 .mjs, 0 .ts, 0 .tsx).

## Counts by area and extension

| Area | Extension | Files | With JSX |
|---|---:|---:|---:|
| desktop | `.mjs` | 3 | 0 |
| expo | `.js` | 4 | 1 |
| gitbook | `.js` | 11 | 9 |
| gitbook | `.mjs` | 2 | 0 |
| gitbook | `.ts` | 1 | 0 |
| host | `.js` | 280 | 0 |
| host | `.jsx` | 8 | 8 |
| host | `.mjs` | 147 | 0 |
| root | `.mjs` | 1 | 0 |
| scripts | `.js` | 4 | 0 |
| scripts | `.mjs` | 4 | 0 |
| web | `.js` | 516 | 180 |
| web | `.jsx` | 38 | 38 |
| web | `.mjs` | 89 | 0 |
| web | `.ts` | 1 | 0 |

## Consumer reference data

`inventory.json` contains each local import/export/dynamic-import/require reference, its source line, and the tracked target it resolves to. Bare package and alias imports are omitted; references that could not be matched to a tracked file remain listed with candidate paths. This is a reproducible syntactic index, not a semantic dependency graph.

## Stage 0 exceptions

This is the complete path-level exception registry recognized by the audit at the baseline revision. Status, reason, and review owner are also stored as structured fields in `inventory.json`.

| Path | Status | Reason | Review owner |
|---|---|---|---|
| `desktop/dist/index.html` | temporary | Inline bootstrap is retained because extraction may change pre-render timing; reassess during the desktop and host UI migration stage. | migration coordinator |
| `desktop/scripts/genMenuIcons.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `desktop/scripts/update-latest-json.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `eslint.config.mjs` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `expo/babel.config.js` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `expo/metro.config.js` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `gitbook/next.config.mjs` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `gitbook/postcss.config.mjs` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `gitbook/scripts/generateContent.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `host/benchmark/batchSizeOptimal.mjs` | permanent | Existing benchmark harnesses are explicitly excluded from source conversion. | migration coordinator |
| `host/benchmark/browserTiles.mjs` | permanent | Existing benchmark harnesses are explicitly excluded from source conversion. | migration coordinator |
| `host/benchmark/tileGridCompare.mjs` | permanent | Existing benchmark harnesses are explicitly excluded from source conversion. | migration coordinator |
| `host/benchmark/tileStrategy.mjs` | permanent | Existing benchmark harnesses are explicitly excluded from source conversion. | migration coordinator |
| `host/cli/scripts/install.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `host/postcss.config.js` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `host/scripts/lockScreenServiceInstall.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `host/scripts/lockScreenServiceUninstall.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `host/scripts/lockScreenServiceWorker.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `host/tailwind.config.js` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `host/ui/index.html` | temporary | Inline bootstrap is retained because extraction may change pre-render timing; reassess during the desktop and host UI migration stage. | migration coordinator |
| `host/vite.config.js` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `scripts/buildPkg.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/buildWebStatic.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/fixAgentText.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/generateIcons.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/obfuscatorConfig.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/syncLocalAgent.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/syncSecrets.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `scripts/syncVersion.js` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `web/next.config.mjs` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `web/postcss.config.mjs` | permanent | Tool configuration is kept in the format loaded directly by its tool. | migration coordinator |
| `web/scripts/injectHotRoutes.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `web/scripts/injectScheduled.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `web/scripts/injectSignalingDO.mjs` | permanent | Build, release, packaging, or generated-content automation remains JavaScript tooling. | migration coordinator |
| `web/test/loader-alias-hooks.mjs` | temporary | Custom Node test loaders remain MJS while the test execution strategy is selected. | migration coordinator |
| `web/test/loader-alias.mjs` | temporary | Custom Node test loaders remain MJS while the test execution strategy is selected. | migration coordinator |

AST diagnostics: none.
