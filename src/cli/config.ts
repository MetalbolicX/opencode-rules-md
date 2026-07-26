/**
 * src/cli/config.ts
 *
 * Config helpers for the omd CLI installer.
 * Exports: parseJsonc, resolveConfigPath, normalizePlugin, matchesPlugin,
 * dedupePlugins, buildSpecifier, backupIfWritable, rotateBackups,
 * writeAtomically, loadGlobalConfig.
 *
 * Constants:
 *   PLUGIN_NAME            = "opencode-rules-md"
 *   BACKUP_LIMIT           = 3
 *   OPENCODE_CONFIG_SUBDIR = "opencode"
 */

import { join, dirname } from 'path';

import { parseJsonc } from './config-parser.js';
import { resolveConfigPath, type CliFs } from './config-resolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Facade re-exports (parser + resolver extracted to dedicated modules)
// ─────────────────────────────────────────────────────────────────────────────

export { parseJsonc } from './config-parser.js';
export {
  resolveConfigPath,
  OPENCODE_CONFIG_SUBDIR,
  type CliFs,
} from './config-resolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Facade re-exports (plugin-config extracted to dedicated module)
// ─────────────────────────────────────────────────────────────────────────────

export {
  normalizePlugin,
  readInstalledPlugins,
  matchesPlugin,
  findInstalledPlugin,
  dedupePlugins,
  buildSpecifier,
  PLUGIN_NAME,
} from './plugin-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const BACKUP_LIMIT = 3;

// ─────────────────────────────────────────────────────────────────────────────
// loadGlobalConfig
// ─────────────────────────────────────────────────────────────────────────────

export interface GlobalConfig {
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
}

/** Backwards-compatible alias used by update.ts / status.ts. */
export type LoadedConfig = GlobalConfig;

/**
 * Load and parse a global config file.
 * Returns { path, exists, data }. data is {} when file absent or empty.
 * Throws if the file exists but contains malformed JSON.
 */
export function loadGlobalConfig(
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  basename: string = 'opencode'
): GlobalConfig {
  const resolved = resolveConfigPath(fs, env, basename);

  if (!resolved.exists) {
    return { path: resolved.path, exists: false, data: {} };
  }

  const raw = fs.readFileSync(resolved.path);
  try {
    const data = parseJsonc(raw);
    return { path: resolved.path, exists: true, data };
  } catch (err) {
    throw new Error(
      `config file at ${resolved.path} is malformed JSON\n` +
        `Fix the JSON error, or delete the file and re-run.\n` +
        `  error: ${(err as Error).message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup helpers
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
