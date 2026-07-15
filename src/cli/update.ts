// ---------------------------------------------------------------------------
// src/cli/update.ts — `omd update` command implementation.
//
// Like install, update is now a thin wrapper around OpenCode's own CLI.
// We compare the installed version (read from `data['plugin']` — singular —
// with a backward-compat fallback to the legacy `data['plugins']`) against
// the latest npm version. When stale we purge the on-disk cache under
// ~/.cache/opencode/packages/ (the actual location OpenCode uses) and
// invoke `opencode plugin opencode-rules-md --global --force` to refresh
// the registration.
//
// The cache purge matters because OpenCode caches the resolved package
// by specifier — once a cached copy exists, `--force` re-registers without
// re-fetching unless we first remove the stale entry.
// ---------------------------------------------------------------------------

import { homedir } from 'os';
import { join } from 'path';
import { fetchLatestVersion, isStale } from './registry.js';
import {
  loadGlobalConfig,
  matchesPlugin,
  readInstalledPlugins,
  type CliFs,
  type LoadedConfig,
} from './config.js';
import { spawnOpencodePlugin } from './spawn.js';

const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

/** Package directory used by OpenCode to cache plugin installs. */
export const PACKAGES_DIR_BASENAME = ['.cache', 'opencode', 'packages'] as const;

/** Exact cache directory name we look for (bare specifier, no version suffix). */
export const CACHE_DIR_BASENAME = 'opencode-rules-md';

/**
 * Resolve the user's home directory, honoring a custom HOME env var.
 * Used by both resolveCachePaths and the config loader.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? homedir();
}

/**
 * Return the absolute path of the OpenCode packages cache directory.
 */
export function resolvePackagesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHome(env), ...PACKAGES_DIR_BASENAME);
}

/**
 * Return the cache directories that match the opencode-rules-md prefix.
 *
 * Real-world layout under ~/.cache/opencode/packages/ looks like:
 *   opencode-rules-md/
 *   opencode-rules-md@latest/
 *   some-other-plugin/
 *
 * We glob-match anything starting with `opencode-rules-md` (exact or with
 * an `@<version>` suffix). When an injected fs is provided we list the
 * directory and filter; without one we return the two most common shapes
 * so callers can pre-check existence cheaply.
 */
export function resolveCachePaths(
  env: NodeJS.ProcessEnv = process.env,
  fs?: CliFs,
): string[] {
  const packagesDir = resolvePackagesDir(env);
  if (fs && fs.existsSync(packagesDir)) {
    try {
      const entries = fs.readdirSync(packagesDir);
      return entries
        .filter(
          (name) => name === CACHE_DIR_BASENAME || name.startsWith(`${CACHE_DIR_BASENAME}@`),
        )
        .map((name) => join(packagesDir, name));
    } catch {
      return [];
    }
  }
  // No fs injection — return the conventional candidates. Callers that care
  // about existence should still check with existsSync().
  return [
    join(packagesDir, CACHE_DIR_BASENAME),
    join(packagesDir, `${CACHE_DIR_BASENAME}@latest`),
  ];
}

export interface UpdateOptions {
  /** Injected latest version (test seam). Defaults to a real npm lookup. */
  latestVersion?: string | null | undefined;
  /** Print the plan without writing or spawning. */
  dryRun?: boolean;
  /** Injected spawn function (test seam). Defaults to spawnOpencodePlugin. */
  spawn?: typeof spawnOpencodePlugin;
}

export interface UpdateResult {
  status: 'stale' | 'current' | 'unreachable';
  cachePaths: string[];
  /** Re-install instruction; empty when status === 'current'. */
  instruction: string;
}

/**
 * Look up the installed specifier across both config files, returning the
 * first one we find. Returns null when neither file registers the plugin.
 */
function findInstalledSpecifier(loaded: readonly LoadedConfig[]): string | null {
  for (const cfg of loaded) {
    const plugins = readInstalledPlugins(cfg);
    const match = plugins.find((p) => matchesPlugin(p));
    if (match) return match;
  }
  return null;
}

/**
 * Extract the version portion of an `opencode-rules-md@<version>` specifier.
 * Returns null when the specifier has no `@version` segment.
 */
export function extractVersion(specifier: string): string | null {
  const at = specifier.lastIndexOf('@');
  if (at < 0 || at === specifier.length - 1) return null;
  return specifier.slice(at + 1);
}

/**
 * Recursively delete a directory and all its contents using the injected fs.
 * Best-effort — a failed purge is not fatal; we want the update to keep going.
 */
export function purgeDirectory(fs: CliFs, dirPath: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    try {
      if (!fs.existsSync(entryPath)) continue;
      // Probe to differentiate empty dirs / non-empty dirs / files. The injected
      // fs interface does not expose stat, so we try readdir first and fall back
      // to unlink for leaves.
      try {
        const subEntries = fs.readdirSync(entryPath);
        if (subEntries.length === 0) {
          fs.rmdirSync(entryPath);
        } else {
          purgeDirectory(fs, entryPath);
          fs.rmdirSync(entryPath);
        }
      } catch {
        // Not a directory (or unreadable) — best-effort unlink.
        fs.unlinkSync(entryPath);
      }
    } catch {
      // best-effort per entry
    }
  }

  try {
    fs.rmdirSync(dirPath);
  } catch {
    // best-effort
  }
}

/**
 * Run the update command.
 *
 * 1. Resolve the latest published version from npm (or use the injected mock).
 * 2. Read the installed version from the user's opencode config.
 * 3. If unreachable, log and return.
 * 4. If current, log and return.
 * 5. Otherwise: purge stale cache directories, then spawn
 *    `opencode plugin opencode-rules-md --global --force`.
 */
export const runUpdate = async (
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
  _error: (s: string) => void,
  opts: UpdateOptions = {},
): Promise<UpdateResult> => {
  // 1. Resolve latest.
  const latest = opts.latestVersion !== undefined ? opts.latestVersion : await fetchLatestVersion();

  const cachePaths = resolveCachePaths(env, fs);
  const instruction = 'opencode plugin opencode-rules-md --global --force';
  const spawnFn = opts.spawn ?? spawnOpencodePlugin;

  // 2. Unreachable.
  if (latest === null) {
    log('omd: could not determine latest version from npm registry');
    return { status: 'unreachable', cachePaths, instruction };
  }

  // 3. Installed version (read both configs).
  const configs = CONFIG_BASENAMES.map((basename) => loadGlobalConfig(fs, env, basename));
  const installedSpecifier = findInstalledSpecifier(configs);
  const installedVersion = installedSpecifier ? extractVersion(installedSpecifier) : null;

  // 4. Current.
  if (installedVersion !== null && !isStale(installedVersion, latest)) {
    log(`omd: opencode-rules-md@${installedVersion} is already the latest`);
    return { status: 'current', cachePaths, instruction: '' };
  }

  // 5. Stale — describe plan.
  if (opts.dryRun) {
    log('omd: update check (dry-run)');
    log(`  latest version: ${latest}`);
    log(`  installed version: ${installedVersion ?? 'not installed'}`);
    log(`  would purge: ${cachePaths.join(', ') || '(none found)'}`);
    log(`  would instruct: ${instruction}`);
    return { status: 'stale', cachePaths, instruction };
  }

  log(
    installedVersion === null
      ? `omd: opencode-rules-md is not installed; registering latest (${latest})`
      : `omd: opencode-rules-md is stale (installed ${installedVersion}, latest ${latest})`,
  );

  // Purge each matching cache directory. Best-effort per path.
  for (const cachePath of cachePaths) {
    try {
      if (fs.existsSync(cachePath)) {
        purgeDirectory(fs, cachePath);
        log(`omd: purged cache ${cachePath}`);
      }
    } catch {
      // ignore individual purge failures
    }
  }

  // Re-register via OpenCode's CLI. Failure here is fatal — surface it.
  const result = await spawnFn(['opencode-rules-md', '--global', '--force'], {
    env: process.env,
    stdio: 'inherit',
  });

  if ((result.status ?? 0) !== 0) {
    throw new Error(
      `opencode plugin opencode-rules-md --global --force exited with status ${String(result.status)}`,
    );
  }

  return { status: 'stale', cachePaths, instruction: '' };
};