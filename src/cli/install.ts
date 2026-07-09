/**
 * install command: idempotently append opencode-rules to the global config.
 *
 * Pipeline:
 *   loadGlobalConfig → abort if parseError → dedupe → append specifier
 *   → check no-op → (dry-run? print & return "planned")
 *   → rotateBackups → writeAtomically → print & return "wrote"
 */

import { loadGlobalConfig, normalizePlugin, removePlugin, addPlugin, rotateBackups, writeAtomically } from './config.js';
import type { CliFs } from './real-fs.js';
import { realFs } from './real-fs.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface InstallResult {
  status: 'wrote' | 'planned' | 'noop' | 'error';
  path: string;
  specifier: string;
  backup?: string;
  parseError?: Error;
}

// ---------------------------------------------------------------------------
// Run install
// ---------------------------------------------------------------------------

export function runInstall(
  opts: { version?: string; dryRun?: boolean },
  fs: CliFs = realFs
): InstallResult {
  // Load config
  const loadResult = loadGlobalConfig(fs);

  // Abort on parse error — do not corrupt malformed config
  if (loadResult.parseError) {
    return {
      status: 'error',
      path: loadResult.path,
      specifier: buildSpecifier(opts.version),
      parseError: loadResult.parseError,
    };
  }

  const configPath = loadResult.path;
  const config = loadResult.config;

  // Normalize plugin array (dedupe by prefix)
  config['plugin'] = normalizePlugin(config);

  // Build the specifier
  const specifier = buildSpecifier(opts.version);

  // Check if already installed with the same specifier — no-op
  const existing = (config['plugin'] as string[] | undefined) ?? [];
  if (existing.includes(specifier)) {
    return { status: 'noop', path: configPath, specifier };
  }

  // Remove any existing opencode-rules* entries so this specifier is deduplicated
  removePlugin(config, 'opencode-rules');

  // Add the new (or re-added) specifier at the end
  addPlugin(config, specifier);

  // Dry-run: serialize and print planned content, make no changes
  if (opts.dryRun) {
    const planned = JSON.stringify(config, null, 2);
    console.log('Planned config:\n' + planned);
    return { status: 'planned', path: configPath, specifier };
  }

  // Write: rotate backups first, then atomic write
  const backup = rotateBackups(fs, configPath, 'opencode-rules');
  const serialized = JSON.stringify(config, null, 2);
  writeAtomically(fs, configPath, serialized);

  console.log(`Installed ${specifier} to ${configPath}`);
  if (backup) {
    console.log(`Backup written to ${backup}`);
  }

  return { status: 'wrote', path: configPath, specifier, backup };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSpecifier(version?: string): string {
  return version ? `opencode-rules@${version}` : 'opencode-rules';
}
