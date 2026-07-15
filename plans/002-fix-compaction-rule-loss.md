# Plan 002: Fix rule loss after compaction (reset rulesInjected)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5241fcc..HEAD -- src/session-store.ts src/runtime.ts src/session-store.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of plan 001)
- **Category**: bug
- **Planned at**: commit `5241fcc`, 2026-07-15

## Why this matters

When OpenCode compacts a session, it rebuilds the system prompt from scratch.
The plugin guards against re-injecting rules every turn with a `rulesInjected`
flag (`src/runtime.ts:200-205`). The compaction hook (`onSessionCompacting`)
marks the session compacting (`src/runtime.ts:342` → `markCompacting`), and
`shouldSkipInjection` suppresses injection for a 30s window, then clears
`isCompacting`.

**The bug:** when the compaction window expires, `isCompacting` is reset to
`false`, but `rulesInjected` is **never** reset. So after the host rebuilds
its system prompt, `onSystemTransform` sees `rulesInjected === true` and skips
injection. The rules are silently lost from the system prompt for the rest of
the session. The compaction hook only re-adds *file paths* as context text
(`src/runtime.ts:350-357`), never the rule content itself.

This must land before any optimization plan that relies on injection actually
persisting correctly.

## Current state

- `src/session-store.ts`:
  - `SessionState.rulesInjected?: boolean` (line 11).
  - `markCompacting(sessionID, nowMs)` (line 84) sets `isCompacting = true`
    and `compactingSince = nowMs`.
  - `shouldSkipInjection(sessionID, nowMs, ttlMs=30_000)` (line 91): returns
    `false` when not compacting; when the 30s TTL expires it clears
    `isCompacting` (line 109-111) and returns `false` so injection proceeds —
    **but it does not touch `rulesInjected`**.
- `src/runtime.ts`:
  - `onSystemTransform` (line 177): if `sessionState?.rulesInjected` is true
    (line 200) it returns early — no injection.
  - Sets `rulesInjected = true` after injecting (lines 246-249 and 262-266).
  - `onSessionCompacting` (line 324): calls `markCompacting`, adds context
    paths, but never resets `rulesInjected`.
- Tests: `src/session-store.test.ts` covers `SessionStore` behavior;
  `src/runtime.tool-ids.test.ts` covers runtime tool-id querying.

## Commands you will need

| Purpose    | Command                              | Expected on success |
|------------|--------------------------------------|---------------------|
| Tests      | `bun run test:run`                   | exit 0, all pass    |
| Lint       | `bun run lint`                       | exit 0              |
| Typecheck  | `bun run build` (runs `tsc`)         | exit 0, no errors   |
| Format     | `bun run format:check`               | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/session-store.ts` — reset `rulesInjected` when the compaction TTL expires.
- `src/session-store.test.ts` — add regression test for the reset.

**Out of scope** (do NOT touch):
- `src/runtime.ts` — no change needed; it already checks `rulesInjected`.
- `src/rule-filter.ts`, `src/rule-discovery.ts` — unrelated.
- Any change to the 30s TTL value or compaction context-path logic.

## Git workflow

- Branch: `advisor/002-fix-compaction-rule-loss`
- Commit per step; conventional commits, e.g.
  `fix(session-store): reset rulesInjected after compaction window`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reset rulesInjected in shouldSkipInjection when the TTL expires

In `src/session-store.ts`, the `shouldSkipInjection` method already clears
`isCompacting` when the TTL expires (lines 109-111). Extend that same mutation
block to also reset `rulesInjected` so the next `onSystemTransform` re-injects:

```typescript
this.upsert(sessionID, s => {
  s.isCompacting = false;
  s.rulesInjected = false;
});
```

This is the one-line semantic change. Everything else stays.

**Verify**: `bun run build` → exit 0.

### Step 2: Add a regression test in src/session-store.test.ts

Model after the existing tests in `src/session-store.test.ts`. Add a test
inside the existing `describe('SessionStore')` block:

> Given a session that has `rulesInjected = true` and is compacting
> (`markCompacting` called): advancing the clock past the TTL causes
> `shouldSkipInjection` to return `false` AND the session state's
> `rulesInjected` is now `false`.

Use the controllable clock the existing tests already use (the store accepts
explicit `nowMs` arguments to `markCompacting` and `shouldSkipInjection`, so
you do not need to mock real timers — pass increasing millisecond values).

Concretely:
1. `upsert('s1', s => { s.rulesInjected = true; })`.
2. `markCompacting('s1', 1000)`.
3. `shouldSkipInjection('s1', 5000)` → still compacting (returns `true`), and
   `get('s1').rulesInjected` is still `true`.
4. `shouldSkipInjection('s1', 40_000)` → TTL expired (returns `false`), and
   `get('s1').rulesInjected` is now `false` — the assertion that was failing
   before this fix.

**Verify**: `bun run test:run` → all pass, including the new test.

### Step 3: Confirm no double-injection regression

Add (or extend) a test confirming that during the active compaction window
(before TTL) `rulesInjected` is NOT prematurely cleared and injection is still
suppressed. This guards against over-resetting.

**Verify**: `bun run test:run` → all pass.

## Test plan

- New tests in `src/session-store.test.ts`:
  - Compaction TTL expiry resets `rulesInjected` to `false`.
  - During the active window, `rulesInjected` stays as-is and injection is
    still skipped.
- Structural pattern: existing tests in `src/session-store.test.ts` (same
  `describe`, same clock-value style).
- Verification: `bun run test:run` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run build` exits 0
- [ ] `bun run test:run` exits 0; new tests pass
- [ ] `bun run lint` exits 0
- [ ] `bun run format:check` exits 0
- [ ] After TTL expiry, `shouldSkipInjection` returns `false` AND
      `session.rulesInjected === false`
- [ ] During the active compaction window, `rulesInjected` is unchanged
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `shouldSkipInjection` (lines 91-114) does not match the "Current state"
  excerpt — it may have been refactored.
- Resetting `rulesInjected` in the store is insufficient because
  `onSystemTransform` in `src/runtime.ts` has an additional guard you did not
  expect (report what you found; do not edit `runtime.ts` without confirming).
- The existing `session-store.test.ts` does not use explicit millisecond
  arguments (i.e., it relies on real timers) — report and adapt the test
  approach accordingly.

## Maintenance notes

- The compaction flow is the lifecycle event that legitimately requires
  re-injection. Any future change to the host's compaction hook contract
  should re-check this reset path.
- A reviewer should confirm the fix re-injects *exactly once* after
  compaction, not on every subsequent turn — the `rulesInjected` re-arm is
  what makes that work.
- Follow-up explicitly deferred: surfacing a visible signal (debug log) when
  rules are re-injected post-compaction — the existing `debugLog` calls in
  `runtime.ts` already cover this; no new telemetry needed here.
