// ---------------------------------------------------------------------------
// src/cli/uninstall.ts — `omd uninstall` command implementation.
//
// Removes opencode-rules-md from opencode.json and tui.json, and (with
// `--purge`) wipes the OpenCode package cache. Two important fixes vs.
// the previous implementation:
//
//   1. We read & write `data['plugin']` (singular), the field OpenCode
//      actually honors. The previous code wrote `data['plugins']` (plural),
//      which OpenCode silently ignored — so "uninstall" used to leave
//      the plugin effectively installed.
//   2. We also strip a stale `data['plugins']` entry if it exists, so
//      users who upgraded from a buggy `omd install` get their legacy
//      field cleaned up too.
//   3. We purge ~/.cache/opencode/packages/opencode-rules-md* (the real
//      cache OpenCode uses), not the old ~/.cache/opencode/node_modules
//      path.
// ---------------------------------------------------------------------------

import { join } from 'path';
import {
  loadGlobalConfig,
  backupIfWritable,
  rotateBackups,
  writeAtomically,
  type CliFs,
} from './config.js';
import { resolveCachePaths, purgeDirectory } from './update.js';

export const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

export interface UninstallOptions {
  /** Also remove ~/.cache/opencode/packages/opencode-rules-md*. */
  purge?: boolean;
  /** Run the full pipeline without writing to disk. */
  dryRun?: boolean;
  /** Reserved for future prompts — no-op today. */
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
 * Strip `opencode-rules-md` entries from a config payload, cleaning both
 * the modern `plugin` field (array or single string) and any legacy
 * `plugins` field. Returns a tuple [newData, removedCount].
 *
 * `removedCount > 0` indicates the file actually needs to be rewritten.
 */
function stripFromData(data: Record<string, unknown>): {
  next: Record<string, unknown>;
  removed: number;
} {
  let removed = 0;
  const next: Record<string, unknown> = { ...data };

  // Modern field: `plugin` (singular). Accept array or single string.
  const currentRaw = next['plugin'] ?? next['plugins'];
  if (currentRaw !== undefined) {
    if (typeof currentRaw === 'string') {
      if (currentRaw.startsWith('opencode-rules-md')) {
        delete next['plugin'];
        delete next['plugins'];
        removed += 1;
      }
    } else if (Array.isArray(currentRaw)) {
      const filtered = (currentRaw as unknown[]).filter(
        (p) => !(typeof p === 'string' && p.startsWith('opencode-rules-md')),
      );
      if (filtered.length !== currentRaw.length) {
        removed += currentRaw.length - filtered.length;
        if (filtered.length === 0) {
          delete next['plugin'];
          delete next['plugins'];
        } else {
          next['plugin'] = filtered;
          delete next['plugins'];
        }
      }
    }
  }

  return { next, removed };
}

/**
 * Uninstall opencode-rules-md from both opencode.json and tui.json configs.
 *
 * Options:
 *   purge     — also remove ~/.cache/opencode/packages/opencode-rules-md*
 *   dryRun    — run full pipeline without writing to disk
 *   yes       — reserved
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
    const cachePaths = resolveCachePaths(env, fs);
    for (const cachePath of cachePaths) {
      try {
        if (fs.existsSync(cachePath)) {
          purgeDirectory(fs, cachePath);
          purged = true;
        }
      } catch {
        // best-effort — purge failure is non-fatal
      }
    }
  }

  // ── Remove plugin from both configs ─────────────────────────────────────
  for (const basename of CONFIG_BASENAMES) {
    const loaded = loadGlobalConfig(fs, env, basename);

    if (!loaded.exists) {
      results.push({ path: loaded.path, status: 'skipped', backup: null });
      continue;
    }

    const { next, removed } = stripFromData(loaded.data);

    if (removed === 0) {
      results.push({ path: loaded.path, status: 'skipped', backup: null });
      continue;
    }

    anyProcessed = true;

    const newContent = JSON.stringify(next, null, 2) + '\n';

    if (opts.dryRun) {
      results.push({ path: loaded.path, status: 'wrote', backup: null });
      continue;
    }

    // Backup the existing file before rewriting.
    const backup = backupIfWritable(fs, loaded.path);
    if (backup !== undefined) {
      const segs = loaded.path.replace(/\\/g, '/').split('/');
      const base = segs[segs.length - 1] ?? loaded.path;
      const dot = base.lastIndexOf('.');
      const name = dot >= 0 ? base.slice(0, dot) : base;
      const dir = join(...segs.slice(0, -1));
      rotateBackups(fs, dir, name, 3);
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