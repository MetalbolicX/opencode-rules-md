# Plan 001: Establish payload measurement and lock the formatting contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5241fcc..HEAD -- src/rule-filter.ts src/rule-filter.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `5241fcc`, 2026-07-15

## Why this matters

The plugin concatenates every matched rule's full markdown body into one
string and injects it into the model's system prompt (`src/rule-filter.ts:263-268`).
There is currently **no measurement** of how large that payload is and **no
test that locks the output structure**. Existing tests verify *which* rules
match but never assert the exact `formattedRules` string shape or its size.

This is the prerequisite for every later token-optimization plan: you cannot
prove a token reduction without a before-number and a regression guard on the
format. This plan adds both, with **zero behavior change** — it only adds
tests and a pure measurement helper.

## Current state

- `src/rule-filter.ts` — `FilterResult` interface (line 65) returns
  `{ formattedRules: string; matchedPaths: string[] }`. `readAndFormatRules`
  (line 101) assembles the output.
- The exact current output shape (line 263-268):
  ```
  # OpenCode Rules\n\nPlease follow the following rules:\n\n
  {each rule joined by \n\n---\n\n}
  ```
  Each rule is formatted as `` `## ${relativePath}\n\n${strippedContent}` ``
  (line 255).
- Tests: `src/index.rules.test.ts`, `src/index.test.ts`, and
  `src/index.integration.test.ts` exercise matching logic but never assert the
  full `formattedRules` string. There is no `src/rule-filter.test.ts`.
- Repo conventions: Vitest with `describe`/`it`/`expect`. Model after
  `src/session-store.test.ts` for unit-test structure and import style
  (`import { describe, it, expect } from 'vitest'`). TypeScript strict mode.
  Imports use the `.js` extension (`from './rule-filter.js'`) per ESM output
  convention.
- Commands: `bun run test:run` (vitest run), `bun run lint` (eslint src tui).

## Commands you will need

| Purpose    | Command                              | Expected on success |
|------------|--------------------------------------|---------------------|
| Tests      | `bun run test:run`                   | exit 0, all pass    |
| Lint       | `bun run lint`                       | exit 0              |
| Typecheck  | `bun run build` (runs `tsc`)         | exit 0, no errors   |
| Format     | `bun run format:check`               | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/rule-filter.ts` — add an exported `estimateTokens` pure function and
  optionally extend `FilterResult` with a read-only size field (see Step 1).
- `src/rule-filter.test.ts` — **create**; holds the new contract + measurement tests.

**Out of scope** (do NOT touch):
- `src/runtime.ts`, `src/session-store.ts`, `src/rule-discovery.ts`,
  `src/rule-metadata.ts` — no behavior change in this plan.
- Any change to the actual `formattedRules` string produced — this plan only
  *measures* and *asserts* the current shape, it must not alter it.
- Budget enforcement or deduplication — those are plans 003 and 004.

## Git workflow

- Branch: `advisor/001-measure-payload-contract`
- Commit per step; message style: conventional commits, e.g.
  `test(rule-filter): lock formattedRules output contract`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a token-estimate helper (pure, no deps)

Add to `src/rule-filter.ts` a small pure function:

```typescript
/**
 * Rough token estimate using the chars/4 heuristic.
 * No external dependency; accurate enough for budget decisions.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
```

Place it above `readAndFormatRules`. Export it so plan 003 can reuse it.

**Verify**: `bun run build` → exit 0.

### Step 2: Extend FilterResult with an optional size field

Add an optional field to `FilterResult` (line 65) so callers can read the
payload size without re-counting. **Default behavior unchanged** —
`readAndFormatRules` must still return the exact same `formattedRules` string.

```typescript
export interface FilterResult {
  formattedRules: string;
  matchedPaths: string[];
  /** Estimated token count of formattedRules (0 when empty) */
  tokenEstimate: number;
}
```

Update both return sites inside `readAndFormatRules`:
- The early return at line ~106 (empty input): `tokenEstimate: 0`.
- The empty-results return at line ~260: `tokenEstimate: 0`.
- The final return at line ~263: compute
  `const tokenEstimate = estimateTokens(formattedRules)` before the return and
  include it.

**Verify**: `bun run build` → exit 0. Then `bun run test:run` — existing tests
still pass (they ignore the new field).

### Step 3: Create src/rule-filter.test.ts — contract assertions

Create `src/rule-filter.test.ts`. Write tests that lock the exact current
output contract. Import the function under test directly (unit-level, no
filesystem — pass pre-built `DiscoveredRule[]` is not possible because
`readAndFormatRules` reads from disk via `getCachedRule`; instead create real
temp rule files under a temp dir and pass their absolute paths).

Model the temp-file fixture approach after any existing test that writes rule
files (check `src/index.rules.test.ts` for how it sets up on-disk rule files
and clears the cache via `clearRuleCache()` from `./rule-discovery.js`).

Contract tests to write (one `it` each):
1. **Empty input** — `readAndFormatRules([])` returns
   `{ formattedRules: '', matchedPaths: [], tokenEstimate: 0 }`.
2. **Single unconditional rule** — output starts with exactly
   `# OpenCode Rules\n\nPlease follow the following rules:\n\n`.
3. **Rule heading** — each rule appears as `## {relativePath}\n\n{body}`.
4. **Multi-rule separator** — two matched rules are joined by exactly
   `\n\n---\n\n`.
5. **Frontmatter stripped** — a rule file with `---\n...yaml...\n---` frontmatter
   has the frontmatter removed from `formattedRules` (only body appears).
6. **tokenEstimate populated** — for a non-empty result, `tokenEstimate` equals
   `Math.ceil(formattedRules.length / 4)`.
7. **matchedPaths order** — `matchedPaths` reflects discovery order (the order
   of the `files` array passed in).

**Verify**: `bun run test:run` → all pass, including the 7 new tests.

### Step 4: Add a payload-size snapshot for representative rule sets

Add one `describe('payload sizing')` block that builds a representative set
(5 rules, mix of small and ~500-char bodies) and asserts:
- `tokenEstimate > 0` and roughly proportional to total body size.
- The preamble (`# OpenCode Rules...`) plus separators add a fixed overhead
  (assert it is < 60 chars total) — this documents the baseline boilerplate
  cost that later optimization must not regress beyond.

**Verify**: `bun run test:run` → all pass.

## Test plan

- New file `src/rule-filter.test.ts` with the 7 contract tests + the sizing
  block.
- Structural pattern: `src/session-store.test.ts` for import style and
  `describe`/`it`/`expect` usage; `src/index.rules.test.ts` for the on-disk
  rule-file + `clearRuleCache()` fixture approach.
- Verification: `bun run test:run` → all pass, including the new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run build` exits 0 (tsc clean)
- [ ] `bun run test:run` exits 0; `src/rule-filter.test.ts` exists and its tests pass
- [ ] `bun run lint` exits 0
- [ ] `bun run format:check` exits 0
- [ ] `formattedRules` output string is byte-identical to before (verified by the
      contract tests asserting the exact current separators/headers)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/rule-filter.ts:101-269` doesn't match the "Current state"
  excerpts (the codebase has drifted since this plan was written).
- An existing test fails after adding `tokenEstimate` — this means a caller
  does a strict equality check on `FilterResult`; report the caller and stop.
- `clearRuleCache` is not exported or behaves differently than expected when
  building the on-disk fixture (check `src/rule-discovery.ts` exports).
- You discover the assumption "no external token-counting dependency is
  acceptable" is false (i.e., the operator wants `tiktoken` instead) — stop
  and confirm before adding a dependency.

## Maintenance notes

- The `estimateTokens` helper is the shared measurement primitive. Plans 003
  (budget) and 004 (dedup) both depend on it — keep it exported and pure.
- A reviewer should confirm the contract tests assert the **exact** current
  separators. If a later plan intentionally changes them, that plan must also
  update these tests — that is the point.
- Follow-up explicitly deferred: benchmarking real-world rule sets at scale
  (50+ rules) — left to plan 003 once budget enforcement exists.
