# Plan 004: Deduplicate global and project-local rules (local overrides global)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5241fcc..HEAD -- src/rule-discovery.ts src/index.rules.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none (independent; can run alongside 001-003)
- **Category**: tech-debt
- **Planned at**: commit `5241fcc`, 2026-07-15

## Why this matters

`discoverRuleFiles` (`src/rule-discovery.ts:173-205`) appends global rules and
then project-local rules with **no deduplication or precedence**. If a rule
named `coding-standards.md` exists in both `~/.config/opencode/rules/` and
`.opencode/rules/`, **both** are discovered and **both** are injected into the
system prompt as separate `## coding-standards.md` headings — doubling the
token cost for that rule and potentially showing contradictory content.

Per the operator's decision: **project-local rules shadow (override)
same-named global rules.** The local version wins; the global duplicate is
dropped. This matches user intuition (project rules are more specific) and
removes the duplicate tokens.

## Current state

- `src/rule-discovery.ts`:
  - `DiscoveredRule` interface (line 158): `{ filePath: string; relativePath: string }`.
  - `discoverRuleFiles(projectDir?)` (line 173):
    1. Scans global rules dir (`getGlobalRulesDir`, line 179-189).
    2. Scans project-local `.opencode/rules/` (line 192-202).
    3. Pushes both into the same `files` array — **no dedup**.
  - `scanDirectoryRecursively` (line 115) returns `{ filePath, relativePath }`
    where `relativePath` is relative to the scanned base dir. So a global
    `foo.md` and a project `foo.md` both have `relativePath === 'foo.md'` —
    this is the natural dedup key.
  - Subdirectories are scanned recursively (e.g. `typescript/rules.md`).
- Tests: `src/index.rules.test.ts` covers discovery and filtering.
- Conventions: TypeScript strict; ESM `.js` imports; Vitest.

## Commands you will need

| Purpose    | Command                              | Expected on success |
|------------|--------------------------------------|---------------------|
| Tests      | `bun run test:run`                   | exit 0, all pass    |
| Lint       | `bun run lint`                       | exit 0              |
| Typecheck  | `bun run build` (runs `tsc`)         | exit 0, no errors   |
| Format     | `bun run format:check`               | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/rule-discovery.ts` — deduplicate by `relativePath` with project-local
  precedence in `discoverRuleFiles`.
- `src/index.rules.test.ts` — add shadowing/override tests.

**Out of scope** (do NOT touch):
- `src/rule-filter.ts`, `src/runtime.ts`, `src/session-store.ts` — they
  receive the already-deduplicated `DiscoveredRule[]`; no change needed.
- Content-based deduplication (two different files with identical bodies) —
  out of scope; only same-`relativePath` collisions are handled here.
- Merging global + local rule content — explicitly rejected; local fully
  shadows global.

## Git workflow

- Branch: `advisor/004-dedup-global-project-rules`
- Commit per step; conventional commits, e.g.
  `feat(rule-discovery): project-local rules shadow global duplicates`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Deduplicate by relativePath with project-local precedence

In `src/rule-discovery.ts`, refactor `discoverRuleFiles` (line 173) so it
collects results into a `Map<string, DiscoveredRule>` keyed by `relativePath`
instead of pushing directly into an array. Project-local entries are inserted
**after** global entries, so they overwrite (shadow) any global entry with the
same key:

```typescript
export async function discoverRuleFiles(
  projectDir?: string
): Promise<DiscoveredRule[]> {
  // Keyed by relativePath; later insertions shadow earlier ones.
  const byRelativePath = new Map<string, DiscoveredRule>();

  // Discover global rules (recursively) — inserted first (lowest precedence).
  const globalRulesDir = getGlobalRulesDir();
  if (globalRulesDir) {
    const globalRules = await scanDirectoryRecursively(
      globalRulesDir,
      globalRulesDir
    );
    for (const rule of globalRules) {
      debugLog(`Discovered global rule: ${rule.relativePath} (${rule.filePath})`);
      byRelativePath.set(rule.relativePath, rule);
    }
  }

  // Discover project-local rules (recursively) — shadow global duplicates.
  if (projectDir) {
    const projectRulesDir = path.join(projectDir, '.opencode', 'rules');
    const projectRules = await scanDirectoryRecursively(
      projectRulesDir,
      projectRulesDir
    );
    for (const rule of projectRules) {
      const shadowed = byRelativePath.has(rule.relativePath);
      debugLog(
        `Discovered project rule: ${rule.relativePath} (${rule.filePath})` +
          (shadowed ? ' [shadows global]' : '')
      );
      byRelativePath.set(rule.relativePath, rule);
    }
  }

  return Array.from(byRelativePath.values());
}
```

Note: `scanDirectoryRecursively` already returns objects shaped as
`DiscoveredRule` (`{ filePath, relativePath }`), so `rule` can be spread
directly. Preserve insertion order via `Map` iteration order (which is
insertion order in JS) — global rules keep their relative order, shadowed
slots retain their original position but point at the project file.

**Verify**: `bun run build` → exit 0.

### Step 2: Add shadowing tests in src/index.rules.test.ts

Model after existing discovery tests in `src/index.rules.test.ts`. Add a
`describe('rule shadowing')` block. Tests:

1. **Local shadows global** — create `foo.md` in both a (temp) global rules
   dir and a project `.opencode/rules/` dir with distinct content. After
   `discoverRuleFiles`, only **one** entry with `relativePath === 'foo.md'`
   exists, and its `filePath` points at the **project** file.
2. **No false collision** — two rules with different `relativePath`s (e.g.
   `foo.md` and `bar.md`) in the same scope both survive.
3. **Subdirectory paths dedup correctly** — a global `typescript/rules.md`
   and project `typescript/rules.md` collide on `relativePath` and shadow;
   while `typescript/rules.md` and `python/rules.md` do not collide.
4. **Content used is the shadowing (project) file** — after dedup, run
   `readAndFormatRules` on the result and assert the injected body is the
   project version, not the global version.

Use the temp-dir + `clearRuleCache()` fixture pattern from existing tests. For
the global rules dir override, check how tests set `OPENCODE_CONFIG_DIR` /
`XDG_CONFIG_HOME` (see `getGlobalRulesDir`, line 93-106) and replicate that.

**Verify**: `bun run test:run` → all pass, including new tests.

### Step 3: Confirm existing discovery tests still pass unchanged

The existing tests in `src/index.rules.test.ts` that don't involve collisions
must pass without modification (non-colliding discovery is unaffected). If any
existing test breaks, it likely asserted the old duplicate-injection behavior
— that assertion should be updated to reflect the new shadowing semantics, but
report it as a finding rather than silently changing test intent.

**Verify**: `bun run test:run` → all pass.

## Test plan

- New tests in `src/index.rules.test.ts` under `describe('rule shadowing')`.
- Structural pattern: existing tests in `src/index.rules.test.ts` for temp-dir
  fixtures, env-var-based global-dir override, and `clearRuleCache()` usage.
- Verification: `bun run test:run` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run build` exits 0
- [ ] `bun run test:run` exits 0; shadowing tests pass
- [ ] `bun run lint` exits 0
- [ ] `bun run format:check` exits 0
- [ ] A rule with the same `relativePath` in both scopes appears exactly once
      in the result, pointing at the project file
- [ ] Non-colliding rules in both scopes all survive
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `discoverRuleFiles` (lines 173-205) or `scanDirectoryRecursively`
  (lines 115-153) don't match the "Current state" excerpts.
- The existing tests rely on the duplicate-injection behavior in a way that
  can't be reconciled with shadowing (report the failing test and its intent).
- `getGlobalRulesDir` env-var resolution differs in the test environment such
  that the global-dir fixture can't be controlled — report and adapt.
- `relativePath` is NOT a stable collision key (e.g., two different base dirs
  produce different relative-path roots) — report the actual collision behavior.

## Maintenance notes

- The precedence rule is now documented in code: **project-local shadows
  global**, by `relativePath`. If a future feature adds a third scope (e.g.,
  user-vs-machine global), extend the `Map` insertion order to encode that
  precedence.
- Content-based dedup (identical bodies in different files) is intentionally
  NOT handled — only same-path collisions. If duplicate content becomes a
  problem, that's a separate plan with a content-hash approach.
- A reviewer should confirm the debug log surfaces the `[shadows global]`
  marker so users can diagnose why a global rule appears absent.
- Follow-up explicitly deferred: a README note documenting the shadowing
  precedence — fold into the Phase 4 docs plan.
