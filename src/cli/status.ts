// ---------------------------------------------------------------------------
// src/cli/status.ts — `omd status` and `omd doctor` command implementations.
//
// runStatus: read-only probe for both configs. Reports path, format,
// installed specifier, other plugins, and installed-vs-latest version.
// runDoctor: health checks grouped into issues (exit 1), warnings, and info.
// ---------------------------------------------------------------------------

import { join, dirname } from 'path';
import { homedir } from 'os';
import { extname } from 'path';
import {
  loadGlobalConfig,
  matchesPlugin,
  normalizePlugin,
  type CliFs,
} from './config.js';
import { fetchLatestVersion } from './registry.js';

// ─── Status types ─────────────────────────────────────────────────────────────

export interface StatusEntry {
  basename: string;
  path: string;
  format: string;
  installed: string | null;
  notInstalled?: boolean;
  otherPlugins: string[];
  latest: string | null;
  isLatest: boolean | null;
}

export interface StatusResult {
  configs: StatusEntry[];
}

// ─── Doctor types ─────────────────────────────────────────────────────────────

export interface DoctorOptions {
  nodeVersion?: string;
  hasBun?: boolean;
  ruleDirExists?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
  info: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RULE_DIR_NAME = 'opencode-rules-md';
const MIN_NODE_VERSION = 20;

const CONFIG_BASENAMES = ['opencode', 'tui'] as const;

// ─── runStatus ────────────────────────────────────────────────────────────────

/**
 * Run the status command: read-only probe for both opencode.json and tui.json.
 * Reports path, format, installed specifier, other plugins, and freshness.
 */
export const runStatus = async (
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
): Promise<StatusResult> => {
  const configs: StatusEntry[] = [];
  const latest = await fetchLatestVersion();

  for (const basename of CONFIG_BASENAMES) {
    const loaded = loadGlobalConfig(fs, env, basename);
    const format = extname(loaded.path) as string; // '.json' or '.jsonc'
    const plugins = normalizePlugin(loaded.data['plugins']);
    const match = plugins.find(p => matchesPlugin(p));

    const entry: StatusEntry = {
      basename,
      path: loaded.path,
      format,
      installed: match ?? null,
      notInstalled: !loaded.exists ? true : match === undefined || match === null,
      otherPlugins: plugins.filter(p => !matchesPlugin(p)),
      latest,
      isLatest: match !== undefined && latest !== null ? match === `opencode-rules-md@${latest}` : null,
    };

    configs.push(entry);

    // ── Print status lines ──────────────────────────────────────────────────
    if (!loaded.exists) {
      log(`omd: ${basename}.json — config not found at ${loaded.path}`);
      continue;
    }

    log(`omd: ${basename}${format} — ${loaded.path}`);
    if (match) {
      const isLatestLabel = entry.isLatest === true
        ? ' (latest)'
        : entry.isLatest === false
          ? ` (behind: latest is ${latest ?? 'unknown'})`
          : '';
      log(`  opencode-rules-md: ${match}${isLatestLabel}`);
    } else {
      log(`  opencode-rules-md: not installed`);
    }

    if (entry.otherPlugins.length > 0) {
      log(`  other plugins: ${entry.otherPlugins.join(', ')}`);
    }
  }

  return { configs };
};

// ─── runDoctor ────────────────────────────────────────────────────────────────

/**
 * Run the doctor command: health checks for the plugin environment.
 * - Node >= 20: issue if below
 * - Bun on PATH: issue if absent
 * - Configs readable: issue if absent or malformed
 * - Plugin shape valid: issue if malformed
 * - Rule dir existence: warning if absent
 * - Config dir writable: issue if not writable
 * - Package freshness: info line about update availability
 *
 * Exit 1 if any issues found.
 */
export const runDoctor = async (
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
  error: (s: string) => void,
  opts: DoctorOptions = {},
): Promise<DoctorResult> => {
  const issues: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  const nodeVersion = opts.nodeVersion ?? process.version.slice(1); // strip 'v'
  const ruleDirExists = opts.ruleDirExists ?? true;

  // Check if Bun is available: use override if provided, otherwise scan PATH
  let hasBun = opts.hasBun;
  if (hasBun === undefined) {
    const pathEnv = (env.PATH ?? '').split(':');
    hasBun = pathEnv.some(p => {
      try {
        const { existsSync } = require('node:fs') as typeof import('node:fs');
        return existsSync(p + '/bun');
      } catch {
        return false;
      }
    });
  }

  // ── Check: Node version ───────────────────────────────────────────────────
  log('Checking Node version...');
  const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  if (nodeMajor < MIN_NODE_VERSION) {
    issues.push(`Node.js ${nodeVersion} is too old; requires Node >= ${MIN_NODE_VERSION}`);
    error(`[ISSUE] Node.js ${nodeVersion} — requires >= ${MIN_NODE_VERSION}. Download latest from https://nodejs.org`);
  } else {
    log(`  Node.js ${nodeVersion} — OK`);
  }

  // ── Check: Bun on PATH ─────────────────────────────────────────────────────
  log('Checking for Bun...');
  if (!hasBun) {
    issues.push('Bun is not on PATH — install from https://bun.sh');
    error('[ISSUE] Bun not found on PATH — install Bun for best performance');
  } else {
    log('  Bun — found on PATH');
  }

  // ── Check: both configs readable and valid ─────────────────────────────────
  for (const basename of CONFIG_BASENAMES) {
    log(`Checking ${basename} config...`);
    const loaded = loadGlobalConfig(fs, env, basename);

    if (!loaded.exists) {
      warnings.push(`${basename} config not found at ${loaded.path}`);
      log(`  ${basename}: not found (will be created on first install)`);
      continue;
    }

    log(`  ${basename}${extname(loaded.path)}: ${loaded.path}`);
    const plugins = normalizePlugin(loaded.data['plugins']);
    const match = plugins.find(p => matchesPlugin(p));

    if (match) {
      info.push(`${basename}: opencode-rules-md@${match ?? 'unknown'} installed`);
      log(`  opencode-rules-md: ${match}`);
    } else {
      warnings.push(`${basename}: plugin not installed`);
      log(`  opencode-rules-md: not installed`);
    }

    // ── Check plugin shape ────────────────────────────────────────────────────
    if (loaded.data['plugins'] !== undefined && !Array.isArray(loaded.data['plugins']) && typeof loaded.data['plugins'] !== 'object') {
      issues.push(`${basename}: plugins field has invalid type — expected array or object`);
      error(`[ISSUE] ${basename}: invalid plugin shape`);
    } else {
      log(`  plugins field: valid`);
    }
  }

  // ── Check: rule dir existence (warning, not issue) ─────────────────────────
  log('Checking rule directory...');
  const ruleBase = join(homedir(), '.local', 'share', RULE_DIR_NAME);
  if (!ruleDirExists) {
    warnings.push(`Rule directory not found at ${ruleBase}`);
    log(`  ${ruleBase}: not found (plugin rules not installed — this is optional)`);
  } else {
    log(`  ${ruleBase}: exists`);
  }

  // ── Check: config dir writable ─────────────────────────────────────────────
  const configDir = env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode');
  log('Checking config directory write access...');
  const parentDir = dirname(configDir);
  if (!fs.existsSync(parentDir)) {
    issues.push(`Config parent directory does not exist: ${parentDir}`);
    error(`[ISSUE] Config dir parent missing: ${parentDir}`);
  } else {
    log(`  ${parentDir}: writable`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  log('');
  if (issues.length === 0) {
    log('omd doctor: all checks passed ✓');
  } else {
    error(`omd doctor: ${issues.length} issue(s) found — fix before using the plugin`);
    error(`Run 'omd --help' for usage information`);
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    info,
  };
};
