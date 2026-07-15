// ---------------------------------------------------------------------------
// src/cli/install.ts — `omd install` command implementation.
//
// Dual-config install loop: iterates over ["opencode", "tui"], loads each
// config, normalizes + deduplicates the plugin list, appends the fresh
// specifier, and writes atomically with a timestamped backup. When the version
// is omitted or "latest", the latest published npm version is resolved so the
// written specifier matches the concrete version (important for accurate
// update checks) and any stale local cache can be purged.
// ---------------------------------------------------------------------------

import { dirname, join } from 'path';
import {
  PLUGIN_NAME,
  loadGlobalConfig,
  matchesPlugin,
  normalizePlugin,
  backupIfWritable,
  rotateBackups,
  writeAtomically,
  type CliFs,
} from './config.js';
import { fetchLatestVersion } from './registry.js';
import { purgeDirectory, resolveCachePath } from './update.js';

export const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

export interface InstallOptions {
  version?: string;
  dryRun?: boolean;
  yes?: boolean;
  /**
   * Optional injection point for tests: pretend the npm registry returned this
   * version when the requested version is "latest" or unset. When omitted,
   * `fetchLatestVersion()` is called against the real npm registry.
   */
  latestVersion?: string | undefined;
}

export interface InstallResultPerFile {
  path: string;
  status: 'wrote' | 'skipped' | 'error';
  backup: string | null;
}

export interface InstallResult {
  status: 'wrote' | 'skipped';
  results: InstallResultPerFile[];
  /** True when a stale local cache directory was purged after writing. */
  purged?: boolean;
}

/**
 * Resolve the concrete version to write.
 *
 * - If the user supplied an explicit version (not "latest" and not empty), use
 *   it unchanged.
 * - Otherwise, ask the npm registry for the latest published version.
 * - If the registry is unreachable, fall back to the literal "@latest" tag so
 *   the install command never hard-fails due to network issues. This preserves
 *   the previous behavior while still allowing the cache check to compare when
 *   a concrete version is known.
 */
async function resolveVersion(opts: InstallOptions): Promise<string> {
  const raw = opts.version?.trim() ?? '';
  const wantsLatest = raw === '' || raw === 'latest';

  if (!wantsLatest) {
    return raw;
  }

  // Tests can short-circuit the network call via latestVersion.
  if (opts.latestVersion !== undefined) {
    return opts.latestVersion;
  }

  const latest = await fetchLatestVersion();
  return latest ?? 'latest';
}

/**
 * Read the version field from a cached package.json, if present.
 * Returns null when the file is missing or unreadable.
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
    // A broken cache is treated as "version unknown" so it gets purged.
    return null;
  }
}

/**
 * Purge the local cache directory when it is stale relative to the version we
 * just installed. If the cache version cannot be determined, we err on the
 * side of purging so the next npx invocation fetches a fresh copy.
 */
function purgeCacheIfStale(
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  resolvedVersion: string,
): boolean {
  // The literal "latest" tag is not a comparable version; we only purge when
  // we have a concrete resolved version to compare against.
  if (resolvedVersion === 'latest') {
    return false;
  }

  const cachePath = resolveCachePath(env);
  if (!fs.existsSync(cachePath)) {
    return false;
  }

  const cacheVersion = readCacheVersion(fs, cachePath);
  if (cacheVersion === null || cacheVersion !== resolvedVersion) {
    purgeDirectory(fs, cachePath);
    return true;
  }

  return false;
}

/**
 * Install opencode-rules-md into both opencode.json and tui.json configs.
 *
 * Options:
 *   version    — npm version specifier (default: latest from registry)
 *   dryRun     — run full pipeline without writing to disk
 *   yes        — accepted for future prompts, no-op here
 *   latestVersion — test hook for the resolved latest version
 */
export const runInstall = async (
  opts: InstallOptions = {},
  fs: CliFs,
  env: NodeJS.ProcessEnv,
): Promise<InstallResult> => {
  const resolvedVersion = await resolveVersion(opts);
  const freshEntry = `${PLUGIN_NAME}@${resolvedVersion}`;
  const results: InstallResultPerFile[] = [];
  let anyProcessed = false;

  for (const basename of CONFIG_BASENAMES) {
    const loaded = loadGlobalConfig(fs, env, basename);
    const plugins = normalizePlugin(loaded.data['plugins']);

    // Find existing entry for this plugin
    const existingEntry = plugins.find(p => matchesPlugin(p));

    // No-op if the same specifier is already installed
    if (existingEntry === freshEntry) {
      results.push({ path: loaded.path, status: 'skipped', backup: null });
      continue;
    }

    anyProcessed = true;

    // Build the new plugin list: remove all matching entries, append fresh specifier.
    // Existing non-matching plugins are preserved in their original order.
    const withoutStale = plugins.filter(p => !matchesPlugin(p));
    const newPlugins = [...withoutStale, freshEntry];

    const newData = { ...loaded.data, plugins: newPlugins };
    const newContent = JSON.stringify(newData, null, 2) + '\n';

    if (opts.dryRun) {
      results.push({ path: loaded.path, status: 'wrote', backup: null });
      continue;
    }

    // Backup the existing file if it exists
    let backup: string | undefined;
    if (loaded.exists) {
      backup = backupIfWritable(fs, loaded.path);
      if (backup !== undefined) {
        const dir = dirname(loaded.path);
        const segs = loaded.path.replace(/\\/g, '/').split('/');
        const base = segs[segs.length - 1] ?? loaded.path;
        const dot = base.lastIndexOf('.');
        const name = dot >= 0 ? base.slice(0, dot) : base;
        rotateBackups(fs, dir, name, 3);
      }
    }

    writeAtomically(fs, loaded.path, newContent);
    results.push({
      path: loaded.path,
      status: 'wrote',
      backup: backup ?? null,
    });
  }

  // After writing the configs, purge a stale local cache so the next run of the
  // plugin starts from the version we just registered. In dry-run mode we
  // never touch the filesystem.
  let purged = false;
  if (!opts.dryRun) {
    purged = purgeCacheIfStale(fs, env, resolvedVersion);
  }

  return {
    status: anyProcessed ? 'wrote' : 'skipped',
    results,
    purged,
  };
};
