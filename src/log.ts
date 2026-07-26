/**
 * Plugin-wide logging helpers.
 */

/**
 * Log a warning to the console using the canonical plugin format.
 *
 * Centralises the `[opencode-rules-md] Warning: <context>: <message>` shape so
 * every warning site stays consistent. The `err` argument is normalised the
 * same way the previous inline `console.warn` calls did: Error instances use
 * `.message`; everything else is coerced via `String(err)`.
 *
 * @param context - Short human-readable description of where the warning came from
 * @param err - The value that triggered the warning (typically an Error)
 */
export function logWarning(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[opencode-rules-md] Warning: ${context}: ${message}`);
}
