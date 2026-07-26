## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 850–950 (four moved modules plus facade replacement) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 parser/resolver; PR 2 plugin-config; PR 3 writer/final facade |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Extract parser and resolver; wire their facade exports | PR 1 | `pnpm exec tsc --noEmit` | `pnpm test:run` — unchanged config contract | Revert parser/resolver and their facade wiring |
| 2 | Extract plugin helpers and constants; wire plugin exports | PR 2 | `pnpm test:run` | N/A — pure library helpers; config tests are the runtime proof | Revert plugin-config and its facade wiring |
| 3 | Extract writer helpers; finish facade and verify all exports | PR 3 | `pnpm test:run && pnpm exec tsc --noEmit` | N/A — filesystem behavior is covered by the existing fake-FS tests | Revert writer and final facade changes |

The design marks the threat matrix N/A, so no threat-specific RED tasks are required.

## 1. Implementation

- [x] 1.1 Create `src/cli/config-parser.ts` with exported `parseJsonc(content: string): Record<string, unknown>` and private `isInsideString`; move the JSONC state machine without adding exports. (PR 1 — `df28bd1` → `bbfab76`)
- [x] 1.2 Create `src/cli/config-resolver.ts` with exported `CliFs`, `resolveConfigPath(fs, env, basename)`, private `resolveConfigDir`, and `OPENCODE_CONFIG_SUBDIR`; preserve `.json`/`.jsonc` precedence and `exists` behavior. (PR 1 — `df28bd1` → `bbfab76`)
- [x] 1.3 Create `src/cli/plugin-config.ts` with `PLUGIN_NAME`, `normalizePlugin`, `readInstalledPlugins`, `matchesPlugin`, `findInstalledPlugin`, `dedupePlugins`, `buildSpecifier`, and private `escapeRegex`; import `GlobalConfig` type-only from the facade. (PR 2 — `4b9f10b` → `c75e1a7`)
- [x] 1.4 Create `src/cli/config-writer.ts` with `BACKUP_LIMIT`, `backupIfWritable`, `rotateBackups`, `writeAtomically`, and private `timestamp`; import `CliFs` as a type from `config-resolver.ts`. (PR 3 — `f1fc7a9`)

## 2. Facade

- [x] 2.1 Reduce `src/cli/config.ts` to `loadGlobalConfig`, `GlobalConfig`, `LoadedConfig`, and explicit re-exports of `parseJsonc`, `resolveConfigPath`, `normalizePlugin`, `readInstalledPlugins`, `matchesPlugin`, `findInstalledPlugin`, `dedupePlugins`, `buildSpecifier`, `backupIfWritable`, `rotateBackups`, `writeAtomically`, `PLUGIN_NAME`, `BACKUP_LIMIT`, `OPENCODE_CONFIG_SUBDIR`, and `CliFs`. (Final state on PR 3 — `f1fc7a9`)
- [x] 2.2 Use `export { ... } from './...js'` for runtime values and `export type { CliFs } from './config-resolver.js'`; keep `loadGlobalConfig` composing `resolveConfigPath` then `parseJsonc` with the existing error context. (Final state on PR 3 — `f1fc7a9`)

## 3. Verification

- [x] 3.1 Run `pnpm exec tsc --noEmit`; require zero errors and no source changes in the six production importers. (Verified: 0 errors; 6 importers unchanged from `main^` to HEAD)
- [x] 3.2 Run `pnpm test:run`; require 532 passing tests (478 baseline + 54 new) with `src/cli/config.test.ts` byte-for-byte unchanged. (Verified: 532 passed; `config.test.ts` diff empty from `main^` to HEAD)
- [x] 3.3 Run `pnpm format:check` on touched files only; if needed, run `pnpm format` only on those files, then repeat tsc and tests. (Replaced with `pnpm run lint` per task verification — 0 errors)
- [x] 3.4 Compare `src/cli/{status,install,uninstall,update,main,real-fs}.ts` against the pre-change commit and confirm zero source changes. (Verified: diff against `main^` is empty)

## 4. Rollback readiness

- [x] 4.1 Document in the PR description: `git checkout HEAD -- src/cli/config.ts` and `rm src/cli/config-{parser,resolver,plugin-config,writer}.ts`; no importer rollback is needed. (Captured in PR 3 commit message and `design.md:38`)

## 5. Verify phase

- [x] 5.1 Read `proposal.md`, `specs/config-management/spec.md`, `design.md`, and `tasks.md`.
- [x] 5.2 Read the 4 focused modules + the facade (`src/cli/config.ts`).
- [x] 5.3 Build a compliance matrix mapping all 6 requirements and 27 scenarios to COMPLIANT/FAILING/UNTESTED with evidence pointers.
- [x] 5.4 Run `pnpm exec tsc --noEmit`, `pnpm test:run`, `pnpm run lint`, and the diff checks against `main^`.
- [x] 5.5 Write `verify-report.md` with the sdd-verify result contract.
- [x] 5.6 Update `tasks.md` checkboxes for all 11 implementation/verification tasks.
