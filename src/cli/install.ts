// ---------------------------------------------------------------------------
// src/cli/install.ts — `omd install` command implementation.
//
// Dual-config install loop: iterates over ["opencode", "tui"], loads each
// config, normalizes + deduplicates the plugin list, appends the fresh
// specifier, and writes atomically with a timestamped backup.
// ---------------------------------------------------------------------------

import { dirname } from 'path';
import {
  PLUGIN_NAME,
  buildSpecifier,
  loadGlobalConfig,
  matchesPlugin,
  normalizePlugin,
  backupIfWritable,
  rotateBackups,
  writeAtomically,
  type CliFs,
} from './config.js';

export const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

export interface InstallOptions {
  version?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export interface InstallResultPerFile {
  path: string;
  status: 'wrote' | 'skipped' | 'error';
  backup: string | null;
}

export interface InstallResult {
  status: 'wrote' | 'skipped';
  results: InstallResultPerFile[];
}

/**
 * Install opencode-rules-md into both opencode.json and tui.json configs.
 *
 * Options:
 *   version   — npm version specifier (default: @latest)
 *   dryRun    — run full pipeline without writing to disk
 *   yes       — accepted for future prompts, no-op here
 */
export const runInstall = (
  opts: InstallOptions = {},
  fs: CliFs,
  env: NodeJS.ProcessEnv,
): InstallResult => {
  const specifier = buildSpecifier(opts.version);
  const results: InstallResultPerFile[] = [];
  let anyProcessed = false;

  for (const basename of CONFIG_BASENAMES) {
    const loaded = loadGlobalConfig(fs, env, basename);
    const plugins = normalizePlugin(loaded.data['plugins']);

    // Find existing entry for this plugin
    const existingEntry = plugins.find(p => matchesPlugin(p));
    const freshEntry = PLUGIN_NAME + specifier;

    // No-op if the same specifier is already installed
    if (existingEntry === freshEntry) {
      results.push({ path: loaded.path, status: 'skipped', backup: null });
      continue;
    }

    anyProcessed = true;

    // Build the new plugin list: remove all matching entries, append fresh specifier
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

  return {
    status: anyProcessed ? 'wrote' : 'skipped',
    results,
  };
};
