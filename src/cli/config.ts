/**
 * src/cli/config.ts
 *
 * Config helpers for the omd CLI installer.
 * Thin facade — owns loadGlobalConfig, GlobalConfig, LoadedConfig,
 * and re-exports all public symbols from the four focused modules.
 *
 * Exports re-exported from modules:
 *   config-parser:  parseJsonc
 *   config-resolver: resolveConfigPath, OPENCODE_CONFIG_SUBDIR, CliFs
 *   plugin-config:  normalizePlugin, readInstalledPlugins, matchesPlugin,
 *                   findInstalledPlugin, dedupePlugins, buildSpecifier,
 *                   PLUGIN_NAME
 *   config-writer:  backupIfWritable, rotateBackups, writeAtomically,
 *                   BACKUP_LIMIT
 */

import { parseJsonc } from './config-parser.js';
import {
  resolveConfigPath,
  OPENCODE_CONFIG_SUBDIR,
  type CliFs,
} from './config-resolver.js';
import {
  normalizePlugin,
  readInstalledPlugins,
  matchesPlugin,
  findInstalledPlugin,
  dedupePlugins,
  buildSpecifier,
  PLUGIN_NAME,
} from './plugin-config.js';
import {
  backupIfWritable,
  rotateBackups,
  writeAtomically,
  BACKUP_LIMIT,
} from './config-writer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Explicit re-exports (parser)
// ─────────────────────────────────────────────────────────────────────────────

export { parseJsonc };

// ─────────────────────────────────────────────────────────────────────────────
// Explicit re-exports (resolver)
// ─────────────────────────────────────────────────────────────────────────────

export { resolveConfigPath, OPENCODE_CONFIG_SUBDIR, type CliFs };

// ─────────────────────────────────────────────────────────────────────────────
// Explicit re-exports (plugin-config)
// ─────────────────────────────────────────────────────────────────────────────

export {
  normalizePlugin,
  readInstalledPlugins,
  matchesPlugin,
  findInstalledPlugin,
  dedupePlugins,
  buildSpecifier,
  PLUGIN_NAME,
};

// ─────────────────────────────────────────────────────────────────────────────
// Explicit re-exports (writer)
// ─────────────────────────────────────────────────────────────────────────────

export { backupIfWritable, rotateBackups, writeAtomically, BACKUP_LIMIT };

// ─────────────────────────────────────────────────────────────────────────────
// Types and composition root
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
