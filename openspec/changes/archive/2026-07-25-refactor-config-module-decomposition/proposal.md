# Proposal: Refactor config module decomposition

## Why

`src/cli/config.ts` has grown to ~500 lines and mixes five distinct concerns — JSONC parsing, config path resolution, plugin field normalization/matching, backup rotation, and atomic writes. Each concern changes on its own cadence, but the tangled responsibilities make the file hard to read, test, and maintain. The code-health audit flagged this as Phase 3 and the primary architectural bottleneck in the CLI layer.

## What Changes

- Split `src/cli/config.ts` into four focused modules colocated under `cli/`:
  - `cli/config-parser.ts` — `parseJsonc` and its private helper `isInsideString` (the JSONC comment-stripping state machine).
  - `cli/config-resolver.ts` — `resolveConfigPath` plus the private `resolveConfigDir` (config directory/path resolution).
  - `cli/plugin-config.ts` — `normalizePlugin`, `readInstalledPlugins`, `matchesPlugin`, `findInstalledPlugin`, `dedupePlugins`, `buildSpecifier`, and the private `escapeRegex` (plugin field normalization and matching).
  - `cli/config-writer.ts` — `backupIfWritable`, `rotateBackups`, `writeAtomically`, and the private `timestamp` (backup rotation and atomic writes).
- Reduce `cli/config.ts` to a thin facade that owns the composition root (`loadGlobalConfig` and its `GlobalConfig` / `LoadedConfig` types) and re-exports every previously-exported symbol, so all existing `./config.js` imports keep resolving. No **BREAKING** changes.
- Relocate cross-cutting constants and the `CliFs` interface to the most appropriate module(s) (`PLUGIN_NAME`, `BACKUP_LIMIT`, `OPENCODE_CONFIG_SUBDIR`, `CliFs`) and re-export them from the facade so existing imports remain valid.

## Impact

- **Affected specs:** new capability `config-management` — to be authored in the spec phase as `openspec/changes/refactor-config-module-decomposition/specs/config-management/spec.md` (ADDED requirements capturing the four module boundaries, private-helper ownership, and the facade re-export contract). No existing specs are modified.
- **Affected code:** `src/cli/config.ts` is split into 4 modules + a facade. The 6 production importers (`src/cli/{status,install,uninstall,update,main,real-fs}.ts`) and `src/cli/config.test.ts` require NO source changes — they import via `./config.js`, which the facade continues to satisfy.
- **Public API:** preserved verbatim through facade re-exports. `loadGlobalConfig` is called from `status.ts` (×2), `update.ts`, `uninstall.ts`, and `config.test.ts` (×3); all of these MUST continue to compile and pass unmodified. This is the acceptance signal for the facade contract.
- **Test coverage:** `src/cli/config.test.ts` must pass unchanged, validating the facade. New per-module unit tests are out of scope and may follow in a separate change.
- **Rollback:** revert is a single-file restoration of `src/cli/config.ts` plus deletion of the four new modules; no external API or importer changes need undoing.
