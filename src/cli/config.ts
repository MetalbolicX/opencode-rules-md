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
import { homedir } from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const PLUGIN_NAME = 'opencode-rules-md' as const;
export const BACKUP_LIMIT = 3;
export const OPENCODE_CONFIG_SUBDIR = 'opencode';

// ─────────────────────────────────────────────────────────────────────────────
// CliFs interface
// ─────────────────────────────────────────────────────────────────────────────

export interface CliFs {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  rmdirSync(path: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseJsonc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse JSONC (JSON with Comments) content.
 * Strips single-line and multi-line comments and trailing commas.
 * Returns an empty object for empty/whitespace-only input.
 * Throws if the stripped content is not valid JSON.
 */
export function parseJsonc(content: string): Record<string, unknown> {
  if (content.trim() === '') {
    return {};
  }

  // String-aware comment stripping with bracket-depth tracking.
  let out = '';
  let i = 0;
  // Bracket depth outside strings: +1 for {, -1 for }, +1 for [, -1 for ].
  let depth = 0;

  while (i < content.length) {
    const ch = content[i]!;

    // Start of // comment — strip until newline or end-of-string.
    if (ch === '/' && content[i + 1] === '/' && !isInsideString(out)) {
      let j = i + 2;
      while (j < content.length && content[j] !== '\n') {
        j++;
      }
      out += ' '; // replace the comment with a single space
      // If we stopped at a newline (not EOF): skip the newline — it is the
      // comment terminator, not JSON content. Set i to j so the outer loop
      // increments past the newline without adding it.
      if (j < content.length && content[j] === '\n') {
        i = j; // outer i++ lands on j (the newline), then increments to j+1
        continue;
      }
      // EOF (j >= content.length): the comment runs to end of file.
      // Preserve a trailing } or ] at EOF as it is likely the JSON closer.
      if (j >= content.length) {
        const last = content[content.length - 1]!;
        if (last === '}' || last === ']') {
          out += last;
        }
        i = j;
      } else {
        i = j - 1; // outer i++ will land on j (EOF terminator position)
      }
      continue;
    }

    // Start of /* */ comment — strip the whole span
    if (ch === '/' && content[i + 1] === '*' && !isInsideString(out)) {
      let j = i + 2;
      while (j < content.length - 1) {
        if (content[j] === '*' && content[j + 1] === '/') {
          j += 2;
          break;
        }
        j++;
      }
      out += ' ';
      i = j;
      continue;
    }

    // Track bracket depth (outside strings)
    if (!isInsideString(out)) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
    }

    out += ch;
    i++;
  }

  // Phase 2a: strip trailing commas before ] or }
  let s = out.replace(/,(\s*[}\]])/g, '$1');

  // Phase 2b: if at root level (depth > 0 means a } was consumed as comment text
  // at EOF) and s has no closing } or ], add it and strip any trailing comma.
  if (depth > 0 && !/[}\]]/.test(s)) {
    s = s.replace(/,(\s*$)/, '') + '}';
    depth = 0; // we repaired it
  }

  if (s.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error('parseJsonc: invalid JSON after stripping comments - ' + msg);
  }
}

/** True if the number of unescaped double or single quotes in `s` is odd. */
function isInsideString(s: string): boolean {
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!inStr && (ch === '"' || ch === "'")) {
      inStr = true;
      strChar = ch;
    } else if (inStr && ch === '\\') {
      i++; // skip escaped char
    } else if (inStr && ch === strChar) {
      inStr = false;
      strChar = '';
    }
  }
  return inStr;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveConfigDir / resolveConfigPath
// ─────────────────────────────────────────────────────────────────────────────

function resolveConfigDir(env: NodeJS.ProcessEnv): string {
  const custom = env.OPENCODE_CONFIG_DIR;
  if (custom && custom.trim() !== '') {
    return custom;
  }

  // Honor the XDG Base Directory Specification when it is set.
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') {
    return join(xdg, OPENCODE_CONFIG_SUBDIR);
  }

  // Fall back to $HOME/.config/opencode before using os.homedir().
  // This keeps tests that control HOME deterministic and avoids loading the
  // wrong global config when the process environment is customized.
  const home = env.HOME;
  if (home && home.trim() !== '') {
    return join(home, '.config', OPENCODE_CONFIG_SUBDIR);
  }

  return join(homedir(), '.config', OPENCODE_CONFIG_SUBDIR);
}

/**
 * Resolve the config path for a given basename.
 * Prefers .json over .jsonc; returns { path, exists }.
 * The path does NOT need to exist — absent configs are valid for first install.
 */
export function resolveConfigPath(
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  basename: string = 'opencode',
): { path: string; exists: boolean } {
  const dir = resolveConfigDir(env);
  const jsonPath = join(dir, basename + '.json');
  const jsoncPath = join(dir, basename + '.jsonc');

  if (fs.existsSync(jsonPath)) {
    return { path: jsonPath, exists: true };
  }
  if (fs.existsSync(jsoncPath)) {
    return { path: jsoncPath, exists: true };
  }

  return { path: jsonPath, exists: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizePlugin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a plugin value (undefined, null, string[], or legacy object)
 * to a flat string[].
 */
export function normalizePlugin(raw: unknown): string[] {
  if (raw == null) {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return Object.keys(obj).filter(k => obj[k] != null && obj[k] !== false);
  }

  if (typeof raw === 'string') {
    return [raw];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// matchesPlugin
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true if entry is the plugin named name (with optional @version).
 */
export function matchesPlugin(entry: string, name: string = PLUGIN_NAME): boolean {
  if (!entry || typeof entry !== 'string') return false;
  if (entry === name) return true;
  const pattern = new RegExp('^' + escapeRegex(name) + '@');
  return pattern.test(entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// dedupePlugins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deduplicate plugin list: remove all entries matching PLUGIN_NAME,
 * then re-append the freshest entry (last occurrence). Other plugins preserved.
 */
export function dedupePlugins(
  plugins: string[],
  name: string = PLUGIN_NAME,
): string[] {
  const others: string[] = [];
  let lastFresh: string | undefined;

  for (const p of plugins) {
    if (matchesPlugin(p, name)) {
      lastFresh = p;
    } else {
      others.push(p);
    }
  }

  const result = [...others];
  if (lastFresh !== undefined) {
    result.push(lastFresh);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSpecifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an npm version specifier.
 * '' | undefined -> '@latest'; explicit -> '@<version>'
 */
export function buildSpecifier(version?: string): string {
  if (!version || version.trim() === '') {
    return '@latest';
  }
  return '@' + version;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadGlobalConfig
// ─────────────────────────────────────────────────────────────────────────────

export interface GlobalConfig {
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
}

/**
 * Load and parse a global config file.
 * Returns { path, exists, data }. data is {} when file absent or empty.
 * Throws if the file exists but contains malformed JSON.
 */
export function loadGlobalConfig(
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  basename: string = 'opencode',
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
      `  error: ${(err as Error).message}`,
    );
  }}

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
  limit: number = BACKUP_LIMIT,
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
export function writeAtomically(fs: CliFs, path: string, content: string): void {
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
