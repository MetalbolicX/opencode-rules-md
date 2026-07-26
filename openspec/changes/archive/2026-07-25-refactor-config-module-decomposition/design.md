# Design: Refactor Config Module Decomposition

## Context

Phase 3 of the code-health audit addresses `src/cli/config.ts` (~500 lines), which currently combines JSONC parsing, config path resolution, plugin normalization/matching, backup rotation, and atomic writes. The change is an internal, non-breaking decomposition: six production importers and `src/cli/config.test.ts` must compile and pass without source edits. The dispatcher’s `nextRecommended: "select-change"` state is resolved by this change; stale candidates (`add-rule-filter-framework`, `refactor-review-findings`, and `test`) are unrelated and out of scope.

## Goals / Non-Goals

- **Goals:** Create cohesive `config-parser.ts`, `config-resolver.ts`, `plugin-config.ts`, and `config-writer.ts` modules; reduce `config.ts` to the `loadGlobalConfig` composition root plus named re-exports; place constants and `CliFs` coherently; preserve every existing `./config.js` import; pass the unchanged facade-contract test.
- **Non-Goals:** No behavior or feature changes; no per-module unit tests (follow-up); no cleanup of stale OpenSpec changes; no attempt to resolve the duplicate `buildSpecifier` exported by `src/cli/install.ts`.

## Decisions

1. **`CliFs` ownership:** Declare `CliFs` in `config-resolver.ts`, the module that defines the injected configuration-filesystem boundary, and import it as a type from the writer. A facade-owned interface preserves compatibility but couples the facade to implementation contracts; a new `cli-fs.ts` would add a file without a second independent consumer boundary.
2. **Constants:** Put `PLUGIN_NAME` in `plugin-config.ts`, `BACKUP_LIMIT` in `config-writer.ts`, and `OPENCODE_CONFIG_SUBDIR` in `config-resolver.ts`. Each is owned by its primary/sole consumer; `config.ts` re-exports all three.
3. **`buildSpecifier`:** Move the `config.ts` implementation to `plugin-config.ts`; leave `install.ts` untouched because its exported function has different install-command semantics. The facade re-exports the config copy. De-duplication is a follow-up.
4. **Facade:** `config.ts` owns only `GlobalConfig`, `LoadedConfig`, and `loadGlobalConfig`; the loader imports `parseJsonc` and `resolveConfigPath`. Use explicit named re-exports such as `export { parseJsonc } from './config-parser.js'` for one greppable public contract surface.
5. **Types:** Keep `GlobalConfig` as a facade `export interface` and `LoadedConfig` as an `export type` alias. Re-export `CliFs` with `export type { CliFs } ...`; `verbatimModuleSyntax: true` makes this the ESM-safe form even though the source declaration is an interface, and existing consumers already use type imports.
6. **Dedupe ordering:** “Most recent” means the last matching occurrence in the input array (array tail wins). This preserves the current `lastFresh` loop behavior, keeps other entries in their original order, and appends the retained plugin entry.
7. **Extraction order:** Create modules in dependency order: parser, resolver, plugin-config, writer, then reduce `config.ts` to the composition root and re-exports. Each step retains a compilable facade so `tsc --noEmit` can be run between steps.

## Risks / Trade-offs

- Duplicate `buildSpecifier` implementations remain → leave `install.ts` unchanged and track a follow-up.
- Stale OpenSpec changes may confuse dispatch → do not delete or modify them here.
- A forgotten facade export would break consumers → validate unchanged `config.test.ts` plus `tsc --noEmit` with all importers untouched.
- Dedupe ambiguity could cause nondeterministic tests → use the array-tail rule above.
- **Threat matrix:** N/A — this is module decomposition; it adds no routing, shell, subprocess, VCS/PR, executable-classification, or process-integration boundary.

## Migration Plan

1. Create the four modules with the existing implementations and moved private helpers/exports.
2. Reduce `config.ts` to `loadGlobalConfig`, `GlobalConfig`, `LoadedConfig`, and all prior named/type re-exports.
3. Run `pnpm exec tsc --noEmit`.
4. Run `pnpm test:run`; expect 532 passing tests (478 baseline + 54 new), including unchanged `config.test.ts`.
5. Run `pnpm format:check` on touched files; if needed, run `pnpm format` only on those files.

Rollback is restoring `src/cli/config.ts` from Git and deleting the four new modules; no importer changes require reversal.

## Open Questions

- [ ] No blocking questions. Reconsider a dedicated `cli-fs.ts` only if additional filesystem contracts emerge.
- [ ] Follow-up: de-duplicate `install.ts`’s `buildSpecifier`; for this change the facade re-exports the `plugin-config.ts` copy.
