// ---------------------------------------------------------------------------
// src/cli/update.ts — `omd update` command implementation.
//
// Fetches latest from npm, compares to installed version, purges the
// ~/.cache/opencode/node_modules/opencode-rules-md cache, and prints the
// reinstall instruction when stale. No auto-reinstall.
// ---------------------------------------------------------------------------

import { homedir } from 'os';
import { join } from 'path';
import { fetchLatestVersion, isStale } from './registry.js';
import { loadGlobalConfig, matchesPlugin, normalizePlugin } from './config.js';
import type { CliFs } from './config.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CACHE_PATH = join(
  homedir(),
  '.cache',
  'opencode',
  'node_modules',
  'opencode-rules-md',
);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UpdateOptions {
  latestVersion?: string | null | undefined;
  dryRun?: boolean;
}

export interface UpdateResult {
  status: 'stale' | 'current' | 'unreachable';
  cachePath: string;
  instruction: string;
}

// ─── Cache path helpers ───────────────────────────────────────────────────────

/**
 * Resolve the local cache directory, honoring a custom HOME environment.
 * Falls back to os.homedir() when HOME is not set, matching the
 * resolveConfigDir fallback strategy.
 */
export function resolveCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.HOME ?? homedir(),
    '.cache',
    'opencode',
    'node_modules',
    'opencode-rules-md',
  );
}

/**
 * Read the cached package.json version, if determinable.
 * Returns null when the cache is missing or unreadable.
 */
function readCacheVersion(fs: CliFs, cachePath: string): string | null {
  const pkgPath = join(cachePath, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) {
      return null;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath)) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

// ─── runUpdate ────────────────────────────────────────────────────────────────

const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

/**
 * Run the update command:
 * 1. Fetch latest version from npm (or use provided mock)
 * 2. Compare to installed version in config
 * 3. If stale: purge cache, print reinstall instruction
 * 4. If current: print "already current"
 * 5. If unreachable: noop
 */
export const runUpdate = async (
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
  _error: (s: string) => void,
  opts: UpdateOptions = {},
): Promise<UpdateResult> => {
  // Use provided latestVersion for testing, otherwise fetch from npm
  const latest = opts.latestVersion !== undefined
    ? opts.latestVersion
    : await fetchLatestVersion();

  const cachePath = resolveCachePath(env);

  if (latest === null) {
    log('omd: could not determine latest version from npm registry');
    return {
      status: 'unreachable',
      cachePath,
      instruction: 'npx opencode-rules-md@latest install',
    };
  }

  // Determine installed version from config (check both configs)
  let installedVersion: string | null = null;
  for (const basename of CONFIG_BASENAMES) {
    const loaded = loadGlobalConfig(fs, env, basename);
    const plugins = normalizePlugin(loaded.data['plugins']);
    const match = plugins.find(p => matchesPlugin(p));
    if (match) {
      // Extract version from specifier (e.g. 'opencode-rules-md@2.0.0' -> '2.0.0')
      const atIndex = match.lastIndexOf('@');
      installedVersion = atIndex >= 0 ? match.slice(atIndex + 1) : null;
      break; // use first config that has it
    }
  }

  const instruction = `npx opencode-rules-md@latest install`;

  // Check staleness: only stale if installed version differs from latest
  if (installedVersion !== null && !isStale(installedVersion, latest)) {
    log(`omd: opencode-rules-md@${installedVersion} is already the latest`);
    return {
      status: 'current',
      cachePath,
      instruction,
    };
  }

  // Before purging, decide whether the cache is actually stale. When the cache
  // version is already equal to the latest resolved version, skip the purge
  // so we do not delete a valid cache. If the version cannot be determined,
  // fall back to purging to be safe.
  const cacheVersion = readCacheVersion(fs, cachePath);
  const shouldPurge = cacheVersion === null || cacheVersion !== latest;

  if (opts.dryRun) {
    log(`omd: update check (dry-run)`);
    log(`  latest version: ${latest}`);
    log(`  installed version: ${installedVersion ?? 'not installed'}`);
    log(`  would purge: ${shouldPurge ? cachePath : '(nothing to purge)'}`);
    log(`  would instruct: ${instruction}`);
    return {
      status: 'stale',
      cachePath,
      instruction,
    };
  }

  // Purge the cache directory using the injected fs (allows test faking)
  if (shouldPurge) {
    try {
      if (fs.existsSync(cachePath)) {
        // Recursively remove contents then the dir itself
        purgeDirectory(fs, cachePath);
      }
    } catch {
      // best-effort — purge failure is non-fatal
    }
  }

  log(`omd: opencode-rules-md is stale (latest: ${latest})`);
  log(`omd: cache purged at ${cachePath}`);
  log(`omd: to reinstall, run:`);
  log(`  ${instruction}`);

  return {
    status: 'stale',
    cachePath,
    instruction,
  };
};

// ─── purgeDirectory ────────────────────────────────────────────────────────────

/**
 * Recursively delete a directory and all its contents using the given fs.
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
      if (fs.existsSync(entryPath)) {
        // Check if it's a directory by trying to read it
        try {
          const subEntries = fs.readdirSync(entryPath);
          if (subEntries.length === 0) {
            // Empty directory
            fs.rmdirSync(entryPath);
          } else {
            // Non-empty directory — recurse
            purgeDirectory(fs, entryPath);
            fs.rmdirSync(entryPath);
          }
        } catch {
          // It's a file — unlink it
          fs.unlinkSync(entryPath);
        }
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
