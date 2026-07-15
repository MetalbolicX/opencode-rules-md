# Plan 003: Enforce a hard token budget with rule priority

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5241fcc..HEAD -- src/rule-filter.ts src/rule-metadata.ts src/rule-filter.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-measure-payload-contract.md (needs `estimateTokens`
  and the `tokenEstimate` field on `FilterResult`)
- **Category**: perf
- **Planned at**: commit `5241fcc`, 2026-07-15

## Why this matters

Every matched rule's full markdown body is concatenated into the system prompt
with **no size limit** (`src/rule-filter.ts:263-268`). A user with 20 verbose
rules can silently burn 10-50k tokens per LLM call — multiplying cost and
risking context-window exhaustion, with no warning.

This plan introduces:
1. An optional **rule priority** field so users can mark rules "keep first."
2. A configurable **hard token cap** that drops whole lowest-priority rules
   when the assembled payload exceeds budget — **never** truncating a rule
   mid-markdown (a half rule confuses the model more than a dropped one).

Per the operator's decision: the cap is **hard** (rules are dropped silently,
not warned-and-included). Priority is honored by sorting descending before
budget selection.

## Current state

- `src/rule-metadata.ts`:
  - `RuleMetadata` interface (line 10) — fields: `globs`, `keywords`, `tools`,
    `model`, `agent`, `command`, `project`, `branch`, `os` (all `string[]`),
    `ci?: boolean`, `match?: 'any' | 'all'`. No priority field.
  - `parseRuleMetadata` (line 75) extracts fields into `ParsedFrontmatter`
    (line 27) via `extractStringArray` + explicit boolean/match handling.
  - `extractStringArray` (line 60) normalizes arrays.
- `src/rule-filter.ts`:
  - `readAndFormatRules` (line 101) iterates `files` in discovery order,
    pushes each matched rule to `ruleContents` (line 255), joins with
    `\n\n---\n\n` (line 266).
  - After plan 001, `FilterResult` includes `tokenEstimate` and there is an
    exported `estimateTokens(text)` helper.
- There is no priority, no budget, no truncation anywhere in the pipeline.
- Conventions: TypeScript strict; ESM imports use `.js` extensions; Vitest
  tests in `src/*.test.ts`.

## Commands you will need

| Purpose    | Command                              | Expected on success |
|------------|--------------------------------------|---------------------|
| Tests      | `bun run test:run`                   | exit 0, all pass    |
| Lint       | `bun run lint`                       | exit 0              |
| Typecheck  | `bun run build` (runs `tsc`)         | exit 0, no errors   |
| Format     | `bun run format:check`               | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/rule-metadata.ts` — add `priority` field to `RuleMetadata` and parse it.
- `src/rule-filter.ts` — accept an optional `maxTokens` budget, sort by
  priority, drop lowest-priority rules when over budget.
- `src/rule-filter.test.ts` — add budget + priority tests.

**Out of scope** (do NOT touch):
- `src/runtime.ts` — the budget is passed through `RuleFilterContext` (see
  Step 3); runtime wiring is a minimal, additive change only if needed for
  the env-var read. Do NOT change hook lifecycle or compaction logic.
- `src/rule-discovery.ts`, `src/session-store.ts` — unrelated.
- Mid-rule truncation, summarization, or hierarchical rule composition —
  explicitly rejected (hard cap drops whole rules only).

## Git workflow

- Branch: `advisor/003-token-budget-priority`
- Commit per step; conventional commits, e.g.
  `feat(rule-filter): enforce hard token budget with rule priority`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add priority to RuleMetadata and parse it

In `src/rule-metadata.ts`:

1. Add to `RuleMetadata` (line 10):
   ```typescript
   /** Higher priority is kept first when a token budget is enforced. Default 0. */
   priority?: number;
   ```
2. Add `priority?: unknown;` to `ParsedFrontmatter` (line 27).
3. In `parseRuleMetadata`, after the `match` extraction (line 128), add:
   ```typescript
   if (typeof parsed.priority === 'number' && Number.isFinite(parsed.priority)) {
     metadata.priority = parsed.priority;
   }
   ```
   This is purely additive — rules without `priority` keep default `undefined`
   (treated as 0 downstream).

**Verify**: `bun run build` → exit 0.

### Step 2: Thread an optional maxTokens budget into the filter

In `src/rule-filter.ts`, extend `RuleFilterContext` (line 73) with an optional
budget field:

```typescript
/** Optional hard token cap; lowest-priority rules are dropped when exceeded. */
maxTokens?: number;
```

Then refactor `readAndFormatRules` so that **after** it has computed the matched
rules (the loop that pushes to `ruleContents`), but **before** the final join
and return, it applies the budget:

1. Collect matched rules into an intermediate array of
   `{ relativePath, strippedContent, priority, tokenCount }` instead of
   pushing strings directly. Keep `matchedPaths` aligned.
2. If `context.maxTokens` is a positive finite number:
   - Sort the matched rules by `priority` **descending** (default priority 0).
     Preserve original discovery order as a stable tiebreaker (rules with equal
     priority keep their relative order — use a stable sort or track original
     index).
   - Greedily accumulate from highest priority down, summing `tokenCount`
     (use `estimateTokens` from plan 001 on each rule's formatted chunk,
     `## ${relativePath}\n\n${strippedContent}`).
   - **Always include at least the single highest-priority rule** even if it
     alone exceeds budget (a system prompt with zero rules defeats the
     purpose; one oversized rule is better than none). Then stop adding once
     the next rule would exceed `maxTokens`.
3. Build `formattedRules` from the surviving set using the existing join
   format (`\n\n---\n\n`) and preamble.
4. `matchedPaths` must reflect only the surviving rules (dropped rules are not
   "matched" for the active-rules state).
5. If `maxTokens` is unset/invalid, behavior is **identical to today**
   (no sorting, no dropping).

**Verify**: `bun run build` → exit 0. `bun run test:run` — plan 001's contract
tests still pass when no `maxTokens` is provided (the no-budget path is
unchanged).

### Step 3: Wire the budget from an env var (minimal, additive)

The budget is sourced from an environment variable so no config-file schema
change is required. In `src/rule-filter.ts` (or wherever the context is built
— check `src/runtime-context.ts` `buildFilterContext`), default `maxTokens`
from:

```typescript
function resolveMaxTokens(): number | undefined {
  const raw = process.env.OPENCODE_RULES_MAX_TOKENS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
```

Call it inside `buildFilterContext` (in `src/runtime-context.ts`) so the
runtime path picks it up automatically. If `buildFilterContext` does not
already construct the context object, add `maxTokens: resolveMaxTokens()` to
the returned `RuleFilterContext`.

**Verify**: `bun run build` → exit 0.

### Step 4: Add budget + priority tests in src/rule-filter.test.ts

Add a `describe('token budget')` block. Tests (each `it`):

1. **No budget = unchanged behavior** — without `maxTokens`, all matched rules
   appear, order preserved (guard that the refactor didn't reorder).
2. **Priority sorting** — two rules, `A` priority 10 and `B` priority 0, with
   a budget too small for both: only `A` survives (higher priority kept).
3. **Stable tiebreak** — two equal-priority rules under a one-rule budget:
   the one discovered first survives.
4. **At least one rule always included** — a budget of `1` token still yields
   the highest-priority rule's heading (even though its body exceeds 1 token).
5. **Whole-rule drops only** — assert no `formattedRules` output contains a
   truncated rule body (the surviving rules' `## ` headings all appear intact
   and complete; dropped rules' headings are entirely absent).
6. **matchedPaths reflects survivors only** — dropped rules are absent from
   `matchedPaths`.
7. **Env var default** — set `process.env.OPENCODE_RULES_MAX_TOKENS` in a test
   (save/restore the original value), confirm the budget is applied without
   passing `maxTokens` explicitly.

**Verify**: `bun run test:run` → all pass, including new tests.

## Test plan

- New tests in `src/rule-filter.test.ts` under `describe('token budget')`.
- Structural pattern: existing tests in `src/rule-filter.test.ts` (from plan
  001) for the on-disk rule-file + `clearRuleCache()` fixture approach.
- Verification: `bun run test:run` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run build` exits 0
- [ ] `bun run test:run` exits 0; budget/priority tests pass
- [ ] `bun run lint` exits 0
- [ ] `bun run format:check` exits 0
- [ ] Without `maxTokens`/env var, output is byte-identical to before (plan 001
      contract tests still pass)
- [ ] Over-budget payloads drop whole rules by ascending priority; at least one
      rule always survives
- [ ] No rule is ever truncated mid-body
- [ ] `OPENCODE_RULES_MAX_TOKENS` env var is honored when set
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `RuleMetadata` or `parseRuleMetadata` (lines 10-142) don't match the
  "Current state" excerpts.
- `estimateTokens` or `FilterResult.tokenEstimate` from plan 001 do not exist
  (plan 001 is a dependency — confirm it landed first).
- `buildFilterContext` in `src/runtime-context.ts` does not return a plain
  `RuleFilterContext` object that you can extend — report its shape and stop.
- Sorting matched rules requires restructuring `readAndFormatRules` beyond
  collecting into an intermediate array (e.g., the function is shared with a
  caller that depends on discovery order in `matchedPaths`) — report and stop.

## Maintenance notes

- The "always keep at least one rule" rule is deliberate: an empty system
  prompt is worse than one over-budget rule. If the operator later wants a
  true zero-floor cap, that's a one-line change but should be a conscious
  decision.
- The env-var approach (`OPENCODE_RULES_MAX_TOKENS`) avoids a config-schema
  migration. If a config-file option is added later, it should take precedence
  over the env var.
- A reviewer should scrutinize: (a) the stable-sort tiebreaker, (b) that
  `matchedPaths` and the surviving rule set stay in sync, and (c) that the
  no-budget path is provably unchanged.
- Follow-up explicitly deferred: a debug log line naming the dropped rules
  when the budget is hit — nice-to-have telemetry, not required for correctness.
