// ---------------------------------------------------------------------------
// src/cli/uninstall.ts — `omd uninstall` command implementation.
//
// Dual-config uninstall: removes opencode-rules-md entries from both configs.
// --purge removes ONLY ~/.cache/opencode/node_modules/opencode-rules-md and
// NEVER touches rule directories.
// ---------------------------------------------------------------------------

import { dirname, join } from 'path';
import { homedir } from 'os';
import {
  loadGlobalConfig,
  matchesPlugin,
  normalizePlugin,
  backupIfWritable,
  rotateBackups,
  writeAtomically,
  type CliFs,
} from './config.js';

export const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

export interface UninstallOptions {
  purge?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

export interface UninstallResultPerFile {
  path: string;
  status: 'wrote' | 'skipped' | 'error';
  backup: string | null;
}

export interface UninstallResult {
  status: 'wrote' | 'skipped';
  results: UninstallResultPerFile[];
  purged: boolean;
}

/**
 * Uninstall opencode-rules-md from both opencode.json and tui.json configs.
 *
 * Options:
 *   purge     — also remove ~/.cache/opencode/node_modules/opencode-rules-md
 *   dryRun    — run full pipeline without writing to disk
 *   yes       — accepted for future prompts, no-op here
 */
export const runUninstall = (
  opts: UninstallOptions = {},
  fs: CliFs,
  env: NodeJS.ProcessEnv,
): UninstallResult => {
  const results: UninstallResultPerFile[] = [];
  let anyProcessed = false;
  let purged = false;

  // ── Purge cache if requested ────────────────────────────────────────────
  if (opts.purge) {
    const cachePath = join(
      homedir(),
      '.cache',
      'opencode',
      'node_modules',
      'opencode-rules-md',
    );
    if (fs.existsSync(cachePath)) {
      try {
        // Check if it's a directory or a file
        const entries = fs.readdirSync(cachePath);
        if (entries.length === 0) {
          // Empty directory — remove it
          fs.rmdirSync(cachePath);
        } else {
          // Has contents — remove contents then the dir
          for (const entry of entries) {
            const entryPath = join(cachePath, entry);
            if (fs.existsSync(entryPath)) {
              try {
                fs.unlinkSync(entryPath);
              } catch {
                // ignore individual file failures
              }
            }
          }
          fs.rmdirSync(cachePath);
        }
        purged = true;
      } catch {
        // best-effort — cache purge failure is non-fatal
      }
    }
  }

  // ── Remove plugin from both configs ─────────────────────────────────────
  for (const basename of CONFIG_BASENAMES) {
    const loaded = loadGlobalConfig(fs, env, basename);
    const plugins = normalizePlugin(loaded.data['plugins']);

    // Filter out all opencode-rules-md entries
    const remaining = plugins.filter(p => !matchesPlugin(p));

    if (remaining.length === plugins.length) {
      // Nothing to remove — no-op for this file
      results.push({ path: loaded.path, status: 'skipped', backup: null });
      continue;
    }

    anyProcessed = true;

    const newData = { ...loaded.data, plugins: remaining };
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
    status: anyProcessed || purged ? 'wrote' : 'skipped',
    results,
    purged,
  };
};
