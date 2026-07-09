/**
 * CLI config helpers: discovery, JSONC-safe parsing, plugin normalization,
 * backup rotation, and atomic write.
 *
 * All filesystem access goes through the CliFs interface so tests can inject
 * an in-memory implementation without touching real disk.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { CliFs } from './real-fs.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoadResult {
  path: string;
  existed: boolean;
  config: Record<string, unknown>;
  parseError?: Error;
}

// ---------------------------------------------------------------------------
// JSONC comment stripper
// ---------------------------------------------------------------------------

/**
 * Strip JSONC comments and trailing commas while preserving
 * comment-like sequences inside string literals.
 */
export function stripJsoncComments(content: string): string {
  let result = '';
  let i = 0;
  while (i < content.length) {
    const char = content[i];

    // Start of string (double-quoted only — JSON only supports double quotes)?
    if (char === '"') {
      result += char;
      i++;
      while (i < content.length) {
        const c = content[i];
        if (c === '\\' && i + 1 < content.length) {
          // Escape sequence — copy both chars verbatim
          result += c + content[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          result += c;
          i++;
          break;
        }
        result += c;
        i++;
      }
      continue;
    }

    // Line comment?
    if (char === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Block comment?
    if (char === '/' && content[i + 1] === '*') {
      i += 2;
      while (i + 1 < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
        i++;
      }
      // Only skip past */ if we actually found it
      if (i + 1 < content.length) {
        i += 2; // skip */
      }
      continue;
    }

    // Trailing comma before } or ]
    if (
      char === ',' &&
      (content[i + 1] === '}' || content[i + 1] === ']')
    ) {
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the global opencode config path using the same precedence as
 * opencode itself: OPENCODE_CONFIG_DIR → XDG_CONFIG_HOME → HOME fallback.
 *
 * On Windows, APPDATA is tried as a last resort when XDG_CONFIG_HOME and
 * HOME are both absent.
 */
export function resolveGlobalConfigPath(
  fs: CliFs,
  opts: { ensureDir?: boolean } = {}
): string {
  const dir = resolveConfigDir();
  if (opts.ensureDir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'opencode.json');
}

function resolveConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }

  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  }

  const home = process.env.HOME || os.homedir();
  if (home) {
    return path.join(home, '.config', 'opencode');
  }

  // Windows fallback
  const appdata = process.env.APPDATA;
  if (appdata) {
    return path.join(appdata, 'opencode');
  }

  throw new Error(
    'Cannot resolve config dir: none of OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, HOME, or APPDATA is set'
  );
}

// ---------------------------------------------------------------------------
// JSONC-safe config load
// ---------------------------------------------------------------------------

/**
 * Load and parse the global opencode config.
 * Treats a missing file as an empty config object (not an error).
 * Surfaces parse errors so callers can exit non-zero without corrupting data.
 */
export function loadGlobalConfig(fs: CliFs): LoadResult {
  const configPath = resolveGlobalConfigPath(fs);

  if (!fs.existsSync(configPath)) {
    return { path: configPath, existed: false, config: {} };
  }

  try {
    const raw = fs.readFileSync(configPath);
    const stripped = stripJsoncComments(raw);
    // Empty after stripping means comment-only file — treat as {}
    if (stripped.trim() === '') {
      return { path: configPath, existed: true, config: {} };
    }
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    return { path: configPath, existed: true, config: parsed };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { path: configPath, existed: true, config: {}, parseError: error };
  }
}

// ---------------------------------------------------------------------------
// Plugin normalization helpers
// ---------------------------------------------------------------------------

/**
 * Return the plugin array with opencode-rules* entries deduplicated by
 * name prefix, keeping the last occurrence of each unique prefix.
 */
export function normalizePlugin(
  config: Record<string, unknown>
): string[] {
  const raw: unknown[] = Array.isArray(config['plugin']) ? config['plugin'] : [];
  const seen = new Map<string, number>(); // prefix → last index
  const result: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const prefix = getPluginPrefix(item);
    seen.set(prefix, result.length);
    result.push(item);
  }

  // Collapse entries sharing a prefix to only the last one
  return collapseByPrefix(result, seen);
}

/**
 * Remove all plugins matching the given prefix (used to dedupe before append).
 */
export function removePlugin(
  config: Record<string, unknown>,
  prefix: string
): void {
  if (!Array.isArray(config['plugin'])) return;
  const raw = config['plugin'] as string[];
  config['plugin'] = raw.filter(
    item => typeof item === 'string' && !item.startsWith(prefix)
  );
}

/**
 * Add a plugin specifier, removing any existing entry with the same prefix first
 * so it ends up at the specified position (default: end). This makes the operation
 * idempotent — re-adding the same specifier just moves it to the end.
 */
export function addPlugin(
  config: Record<string, unknown>,
  specifier: string
): void {
  if (!Array.isArray(config['plugin'])) {
    config['plugin'] = [];
  }
  const plugin = config['plugin'] as string[];
  const prefix = getPluginPrefix(specifier);
  // Remove any existing entry with the same prefix
  const removed = plugin.filter(p => getPluginPrefix(p) !== prefix);
  removed.push(specifier);
  config['plugin'] = removed;
}

// ---------------------------------------------------------------------------
// Backup rotation
// ---------------------------------------------------------------------------

/**
 * Write a timestamped backup of the given config path and rotate so at most
 * 3 backups are retained (oldest deleted first).
 * Returns the path of the newly created backup.
 */
export function rotateBackups(fs: CliFs, configPath: string, _pluginName: string): string {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const timestamp = Date.now();
  const newBak = path.join(dir, `${base}.bak.${timestamp}`);

  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, newBak);
  } else {
    fs.writeFileSync(newBak, '', 'utf-8');
  }

  // Collect existing backups sorted by timestamp (lexical sort on numeric suffix)
  const entries = fs.readdirSync(dir);
  const bakFiles = entries
    .filter(e => e.startsWith(base + '.bak.'))
    .sort();

  // Remove oldest until only 3 remain
  while (bakFiles.length > 3) {
    const oldest = bakFiles.shift()!;
    fs.unlinkSync(path.join(dir, oldest));
  }

  return newBak;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write content to a temporary sibling file then rename it into place.
 * The final path is never in a partially-written state.
 */
export function writeAtomically(fs: CliFs, configPath: string, content: string): void {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const tmpPath = path.join(dir, `.${base}.tmp.${Date.now()}`);

  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the name part of a plugin specifier, stripping any version suffix.
 * e.g. "opencode-rules@0.1.0" → "opencode-rules"
 */
function getPluginPrefix(specifier: string): string {
  const atIdx = specifier.indexOf('@');
  return atIdx === -1 ? specifier : specifier.substring(0, atIdx);
}

/**
 * Collapse plugins by prefix, keeping only the last occurrence of each.
 */
function collapseByPrefix(
  plugins: string[],
  lastSeen: Map<string, number>
): string[] {
  const keptIndices = new Set([...lastSeen.values()]);

  return plugins.filter((_, idx) => keptIndices.has(idx));
}
