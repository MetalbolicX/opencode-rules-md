// ---------------------------------------------------------------------------
// src/cli/install.ts — `omd install` command implementation.
//
// `omd install` is a thin convenience wrapper around OpenCode's own
// `opencode plugin <specifier> --global` command. OpenCode handles the
// correct config field name (`plugin`, singular), manifest reading, and
// cache placement under ~/.cache/opencode/packages/. We no longer edit
// opencode.json or tui.json directly — duplicating that logic was the
// source of the original bug (we wrote `plugins` plural, which OpenCode
// silently ignored).
//
// The bare specifier `opencode-rules-md` (no `@latest`) is intentional:
// it lets OpenCode resolve and refresh the package on every invocation
// without us pinning to a stale version literal.
// ---------------------------------------------------------------------------

import { spawnOpencodePlugin } from './spawn.js';
import type { CliFs } from './config.js';
import { PLUGIN_NAME } from './config.js';

/** Default base specifier used when the caller does not pin a version. */
export const DEFAULT_SPECIFIER = PLUGIN_NAME;

export interface InstallOptions {
  /** Pin to a specific version, e.g. `"2.0.0"`. Falsy means "use the bare specifier". */
  version?: string;
  /** Run the full pipeline without spawning the child process. */
  dryRun?: boolean;
  /** Reserved for future prompts — currently a no-op. */
  yes?: boolean;
  /** Test hook for resolving the latest version (kept for API compatibility). */
  latestVersion?: string | undefined;
  /**
   * Test seam: replaces spawnOpencodePlugin. Defaults to the real CLI wrapper.
   * Pass an object with a compatible signature to assert on calls.
   */
  spawn?: typeof spawnOpencodePlugin;
}

export interface InstallResult {
  /** Whether we actually invoked the opencode CLI. */
  status: 'wrote' | 'skipped';
  /** The specifier passed to `opencode plugin`. Useful for logging. */
  specifier: string;
}

/**
 * Build the specifier to pass to `opencode plugin`.
 *
 * Rules:
 *   - Empty / unset version  → bare `opencode-rules-md` (lets OpenCode refresh).
 *   - Any other value        → `opencode-rules-md@<version>` (pins the install).
 */
export function buildSpecifier(version: string | undefined): string {
  const trimmed = version?.trim() ?? '';
  if (!trimmed || trimmed === 'latest') {
    return DEFAULT_SPECIFIER;
  }
  return `${PLUGIN_NAME}@${trimmed}`;
}

/**
 * Install opencode-rules-md via OpenCode's own plugin command.
 *
 * Options:
 *   version    — optional npm version pin
 *   dryRun     — print the would-be command and skip the spawn
 *   yes        — reserved
 *
 * Returns:
 *   { status: 'skipped', specifier } when dryRun is true
 *   { status: 'wrote',   specifier } on a clean exit
 *
 * Throws on non-zero exit, so the caller (main.ts) can map it to a CLI
 * failure without us swallowing the error.
 */
export const runInstall = async (
  opts: InstallOptions = {},
  // The next two parameters are kept for API compatibility with main.ts.
  // `omd install` no longer reads or writes the user's config files directly,
  // so fs/env are no longer consulted here.
  _fs?: CliFs,
  env?: NodeJS.ProcessEnv,
): Promise<InstallResult> => {
  const specifier = buildSpecifier(opts.version);
  const spawnFn = opts.spawn ?? spawnOpencodePlugin;
  const targetEnv = env ?? process.env;

  if (opts.dryRun) {
    console.log(`omd: would run: opencode plugin ${specifier} --global`);
    return { status: 'skipped', specifier };
  }

  const result = await spawnFn([specifier, '--global'], { env: targetEnv, stdio: 'inherit' });

  if ((result.status ?? 0) !== 0) {
    throw new Error(
      `opencode plugin ${specifier} --global exited with status ${String(result.status)}`,
    );
  }

  return { status: 'wrote', specifier };
};