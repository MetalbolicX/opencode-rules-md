/**
 * src/cli/config-writer.ts
 *
 * Backup rotation and atomic write helpers.
 * Exports: BACKUP_LIMIT, backupIfWritable, rotateBackups, writeAtomically
 */

import { join, dirname } from 'path';

import type { CliFs } from './config-resolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const BACKUP_LIMIT = 3;

// ─────────────────────────────────────────────────────────────────────────────
// timestamp
// ─────────────────────────────────────────────────────────────────────────────

function timestamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return '' + y + m + d + 'T' + hh + mm + ss;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a timestamped backup of path if it exists.
 * Returns the backup path, or undefined if no backup was created.
 */
export function backupIfWritable(fs: CliFs, path: string): string | undefined {
  if (!fs.existsSync(path)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(path);
    const dir = dirname(path);
    const segs = path.replace(/\\/g, '/').split('/');
    const base = segs[segs.length - 1] ?? path;
    const dot = base.lastIndexOf('.');
    const name = dot >= 0 ? base.slice(0, dot) : base;
    const backupPath = join(dir, name + '.bak.' + timestamp());
    fs.writeFileSync(backupPath, content);
    return backupPath;
  } catch {
    return undefined;
  }
}

/**
 * Rotate backups: keep at most `limit` backups matching `basename.bak.*`,
 * deleting the oldest (by timestamp sort) when over limit.
 */
export function rotateBackups(
  fs: CliFs,
  dir: string,
  basename: string,
  limit: number = BACKUP_LIMIT
): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  const prefix = basename + '.bak.';
  const backups = entries
    .filter(e => e.startsWith(prefix))
    .map(e => ({ name: e, path: join(dir, e) }))
    .filter(({ path }) => fs.existsSync(path))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (backups.length <= limit) {
    return;
  }

  const toDelete = backups.slice(0, backups.length - limit);
  for (const { path } of toDelete) {
    try {
      fs.unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// writeAtomically
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write content to path atomically:
 * 1. Write to a sibling .tmp.<name> file
 * 2. renameSync over the target
 * 3. Clean up temp file on error
 */
export function writeAtomically(
  fs: CliFs,
  path: string,
  content: string
): void {
  const dir = dirname(path);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // may already exist
  }

  const segs = path.replace(/\\/g, '/').split('/');
  const base = segs[segs.length - 1] ?? path;
  const dot = base.lastIndexOf('.');
  const name = dot >= 0 ? base.slice(0, dot) : base;
  const ext = dot >= 0 ? base.slice(dot) : '';
  const tmpPath = join(dir, '.tmp.' + name + ext);

  let tempCreated = false;
  try {
    fs.writeFileSync(tmpPath, content);
    tempCreated = true;
    fs.renameSync(tmpPath, path);
  } catch (err) {
    if (tempCreated) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
    }
    throw err;
  }
}
