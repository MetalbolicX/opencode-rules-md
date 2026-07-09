/**
 * status command: read-only probe that reports install state.
 *
 * Reports install state across BOTH the server and TUI configs:
 *   - installed: yes/no (true only when present in both configs)
 *   - serverSpecifier: the registered entry in opencode.json (or undefined)
 *   - tuiSpecifier:    the registered entry in tui.json (or undefined)
 *   - serverPath:      path to the server config
 *   - tuiPath:         path to the TUI config
 *   - version:         bundled CLI version from package.json
 */

import { loadGlobalConfig, TUI_CONFIG_FILENAME } from './config.js';
import type { CliFs } from './real-fs.js';
import { realFs } from './real-fs.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StatusResult {
  /** True only when the plugin is registered in both server and TUI configs. */
  installed: boolean;
  /** Server config path. */
  serverPath: string;
  /** TUI config path. */
  tuiPath: string;
  /** Registered specifier in the server config, if any. */
  serverSpecifier?: string;
  /** Registered specifier in the TUI config, if any. */
  tuiSpecifier?: string;
  /** Whether the server config existed on disk before the probe. */
  serverExisted: boolean;
  /** Whether the TUI config existed on disk before the probe. */
  tuiExisted: boolean;
  /** Bundled CLI version from package.json. */
  version: string;
  /** First parse error encountered, if any (server takes priority). */
  parseError?: Error;
}

// ---------------------------------------------------------------------------
// Run status
// ---------------------------------------------------------------------------

export function runStatus(cliFs: CliFs = realFs): StatusResult {
  const serverLoad = loadGlobalConfig(cliFs);
  const tuiLoad = loadGlobalConfig(cliFs, { filename: TUI_CONFIG_FILENAME });

  const serverSpecifier = findSpecifier(serverLoad);
  const tuiSpecifier = findSpecifier(tuiLoad);

  const installed = serverSpecifier !== undefined && tuiSpecifier !== undefined;

  const result: StatusResult = {
    installed,
    serverPath: serverLoad.path,
    tuiPath: tuiLoad.path,
    serverExisted: serverLoad.existed,
    tuiExisted: tuiLoad.existed,
    version: getVersion(),
  };

  if (serverSpecifier) result.serverSpecifier = serverSpecifier;
  if (tuiSpecifier) result.tuiSpecifier = tuiSpecifier;

  // Surface the first parse error so callers can warn the user
  const parseError = serverLoad.parseError ?? tuiLoad.parseError;
  if (parseError) result.parseError = parseError;

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findSpecifier(load: ReturnType<typeof loadGlobalConfig>): string | undefined {
  if (load.parseError) return undefined;
  const config = load.config;
  const pluginList: string[] = Array.isArray(config['plugin'])
    ? (config['plugin'] as string[])
    : [];
  return pluginList.find(p => p.startsWith('opencode-rules-md'));
}

function getVersion(): string {
  try {
    // Read package.json relative to the project root
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}