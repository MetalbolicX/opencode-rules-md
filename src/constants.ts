/**
 * Shared numeric constants used across the plugin runtime.
 *
 * Kept in a dedicated module so unrelated modules can subscribe to the same
 * values without having to import from each other (which would create a
 * dependency that only exists to share a single number).
 */

/**
 * Time window after `markCompacting` during which rule injection is paused.
 *
 * Used both as the default `ttlMs` argument of `SessionStore.shouldSkipInjection`
 * and as the explicit value passed from `OpenCodeRulesRuntime`. Keeping a
 * single source of truth ensures the call site and the default never drift.
 */
export const COMPACTING_GRACE_PERIOD_MS = 30_000;
