/**
 * install command: idempotently append opencode-rules-md to the global configs.
 *
 * Registers the plugin in BOTH:
 *   - Server config:  ~/.config/opencode/opencode.json
 *   - TUI config:     ~/.config/opencode/tui.json
 *
 * Pipeline (per config):
 *   loadGlobalConfig → abort if parseError (throw) → normalizePlugin
 *   → check no-op → (dry-run? print & return "planned")
 *   → rotateBackups → writeAtomically → print & return "wrote"
 *
 * Errors are surfaced as exceptions instead of silent status returns so
 * the CLI dispatcher can print them.
 */

import {
  loadGlobalConfig,
  normalizePlugin,
  removePlugin,
  addPlugin,
  rotateBackups,
  writeAtomically,
  TUI_CONFIG_FILENAME,
} from './config.js';
import type { CliFs } from './real-fs.js';
import { realFs } from './real-fs.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ConfigUpdateResult {
  status: 'wrote' | 'planned' | 'noop';
  path: string;
  specifier: string;
  backup?: string;
}

export interface InstallResult {
  status: 'wrote' | 'planned' | 'noop';
  specifier: string;
  server: ConfigUpdateResult;
  tui: ConfigUpdateResult;
}

// ---------------------------------------------------------------------------
// Run install
// ---------------------------------------------------------------------------

export function runInstall(
  opts: { version?: string; dryRun?: boolean },
  fs: CliFs = realFs
): InstallResult {
  const specifier = buildSpecifier(opts.version);

  const server = updateConfig(specifier, opts.dryRun ?? false, fs);
  const tui = updateConfig(specifier, opts.dryRun ?? false, fs, {
    filename: TUI_CONFIG_FILENAME,
  });

  const aggregate: InstallResult['status'] =
    server.status === 'wrote' || tui.status === 'wrote'
      ? 'wrote'
      : server.status === 'planned' || tui.status === 'planned'
        ? 'planned'
        : 'noop';

  printSummary(aggregate, specifier, server, tui);

  return { status: aggregate, specifier, server, tui };
}

// ---------------------------------------------------------------------------
// Internal: update a single config file
// ---------------------------------------------------------------------------

interface UpdateOpts {
  filename?: string;
}

function updateConfig(
  specifier: string,
  dryRun: boolean,
  fs: CliFs,
  opts: UpdateOpts = {}
): ConfigUpdateResult {
  const loadResult = loadGlobalConfig(
    fs,
    opts.filename ? { filename: opts.filename } : {}
  );

  // Throw on parse error — better to fail fast than to silently corrupt config
  if (loadResult.parseError) {
    const filename = opts.filename ?? 'opencode.json';
    const err: Error & { configPath?: string } = new Error(
      `opencode-rules-md: ${filename} is malformed — aborting to avoid data loss.\n` +
        `  path:  ${loadResult.path}\n` +
        `  error: ${loadResult.parseError.message}`
    );
    err.configPath = loadResult.path;
    throw err;
  }

  const configPath = loadResult.path;
  const config = loadResult.config;

  // Normalize plugin array (dedupe by prefix)
  config['plugin'] = normalizePlugin(config);

  // Check if already installed with the same specifier — no-op
  const existing = (config['plugin'] as string[] | undefined) ?? [];
  if (existing.includes(specifier)) {
    return { status: 'noop', path: configPath, specifier };
  }

  // Remove any existing opencode-rules-md* entries so this specifier is deduplicated
  removePlugin(config, 'opencode-rules-md');

  // Add the new (or re-added) specifier at the end
  addPlugin(config, specifier);

  // Dry-run: serialize and print planned content, make no changes
  if (dryRun) {
    const planned = JSON.stringify(config, null, 2);
    console.log(`Planned ${configPath}:\n${planned}`);
    return { status: 'planned', path: configPath, specifier };
  }

  // Write: rotate backups first, then atomic write
  const backup = rotateBackups(fs, configPath, 'opencode-rules-md');
  const serialized = JSON.stringify(config, null, 2);
  writeAtomically(fs, configPath, serialized);

  const result: ConfigUpdateResult = { status: 'wrote', path: configPath, specifier };
  if (backup) result.backup = backup;
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSpecifier(version?: string): string {
  return version ? `opencode-rules-md@${version}` : 'opencode-rules-md';
}

function printSummary(
  status: InstallResult['status'],
  specifier: string,
  server: ConfigUpdateResult,
  tui: ConfigUpdateResult
): void {
  if (status === 'noop') {
    console.log(`Already installed (${specifier})`);
    console.log(`  server config: ${server.path}`);
    console.log(`  tui config:    ${tui.path}`);
    return;
  }

  if (status === 'planned') {
    console.log('Dry run complete — no files written.');
    return;
  }

  console.log(`Installed ${specifier}`);
  console.log(`  server config: ${server.path}`);
  if (server.backup) console.log(`    backup:      ${server.backup}`);
  console.log(`  tui config:    ${tui.path}`);
  if (tui.backup) console.log(`    backup:      ${tui.backup}`);
}