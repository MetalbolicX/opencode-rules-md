/**
 * status command: read-only probe that reports install state.
 *
 * Reports:
 *   - installed: yes/no
 *   - specifier: the registered opencode-rules-md entry (or undefined)
 *   - path: config file path
 *   - version: bundled CLI version from package.json
 */

import { loadGlobalConfig } from './config.js';
import type { CliFs } from './real-fs.js';
import { realFs } from './real-fs.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StatusResult {
  installed: boolean;
  path: string;
  specifier?: string;
  version: string;
  parseError?: Error;
}

// ---------------------------------------------------------------------------
// Run status
// ---------------------------------------------------------------------------

export function runStatus(fs: CliFs = realFs): StatusResult {
  const loadResult = loadGlobalConfig(fs);
  const configPath = loadResult.path;

  // Surface parse errors as installed=false
  if (loadResult.parseError) {
    return {
      installed: false,
      path: configPath,
      version: getVersion(),
      parseError: loadResult.parseError,
    };
  }

  const config = loadResult.config;
  const pluginList: string[] = Array.isArray(config['plugin']) ? (config['plugin'] as string[]) : [];

  // Find the opencode-rules-md entry (exact match for idempotency)
  const specifier = pluginList.find(p => p.startsWith('opencode-rules-md'));

  const result: StatusResult = {
    installed: specifier !== undefined,
    path: configPath,
    version: getVersion(),
  };

  if (specifier) {
    result.specifier = specifier;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
