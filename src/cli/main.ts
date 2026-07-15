// ---------------------------------------------------------------------------
// src/cli/main.ts — `omd` CLI entry point.
//
// Command dispatch using node:util.parseArgs.
// Bare `omd` → install (default).
// Exit codes: 0 success/no-op, 1 health failure, 2 usage error.
// ---------------------------------------------------------------------------

import { parseArgs } from 'node:util';
import { runInstall, type InstallOptions } from './install.js';
import { runUninstall, type UninstallOptions } from './uninstall.js';
import { runStatus, runDoctor } from './status.js';
import { runUpdate } from './update.js';
import { createRealFs } from './real-fs.js';
import type { CliFs } from './config.js';

// ─── Usage ───────────────────────────────────────────────────────────────────

const USAGE = `omd — opencode-rules-md plugin manager

Usage:
  omd [command] [options]

Commands:
  install   Register opencode-rules-md in both opencode.json and tui.json
  uninstall Remove opencode-rules-md from both configs
  status    Show installed plugin state for each config
  doctor    Run health checks for the plugin environment
  update    Check for new versions and purge stale cache

Options:
  --dry-run    Show what would be changed without writing
  --version    Pin to a specific version (install only)
  --latest     Use the latest version (install only)
  --purge      Also remove ~/.cache/opencode/node_modules/opencode-rules-md (uninstall only)
  --yes        Accept all prompts automatically

Examples:
  omd               # install with defaults (latest)
  omd install        # same as bare omd
  omd install --dry-run
  omd install --version 2.0.0
  omd uninstall --purge
`.trim();

const printUsage = (stdout: (s: string) => void): void => {
  stdout(USAGE);
};

// ─── Manual argv parsing — extract command before passing to parseArgs ────────

/**
 * Known option flags (long-form).
 * We detect unknown flags by scanning argv for anything starting with `-` or `--`
 * that is NOT in this set.
 */
const KNOWN_FLAGS = new Set([
  '--help', '--dry-run', '--latest', '--purge', '--yes', '--version',
  '-h', '-V',
]);

/**
 * Known short options that take a value.
 * e.g. `--version 2.0.0` → values.version = '2.0.0'
 */
const SHORT_OPTIONS_WITH_VALUE = new Set(['v']);

/**
 * Known long options that take a value.
 */
const LONG_OPTIONS_WITH_VALUE = new Set(['version']);

/**
 * Extract the command name (first non-option positional) from argv.
 * Also returns unknown flags found before the command.
 *
 * Examples:
 *   []           → { command: 'install', args: [], unknownFlags: [] }
 *   ['install']  → { command: 'install', args: [], unknownFlags: [] }
 *   ['notacommand'] → { command: 'notacommand', args: [], unknownFlags: [] }
 *   ['install', '--dry-run'] → { command: 'install', args: ['--dry-run'], unknownFlags: [] }
 *   ['install', '--unknown-opt'] → { command: 'install', args: ['--unknown-opt'], unknownFlags: ['--unknown-opt'] }
 */
function extractCommand(
  argv: string[],
): { command: string | null; unknownFlags: string[] } {
  const unknownFlags: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--') {
      // Argument separator — remaining args are positional
      break;
    }

    if (!arg.startsWith('-')) {
      // First non-option is the command
      if (command === null) {
        command = arg;
      }
      continue;
    }

    // It's an option — check if known
    if (!KNOWN_FLAGS.has(arg)) {
      unknownFlags.push(arg);
    }

    // Skip the value for options that take one
    const flagName = arg.startsWith('--')
      ? arg.slice(2)
      : arg.startsWith('-')
        ? arg.slice(1)
        : '';

    if (
      LONG_OPTIONS_WITH_VALUE.has(flagName) ||
      SHORT_OPTIONS_WITH_VALUE.has(flagName)
    ) {
      // Skip the next argv element if it's not an option itself
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
        i++;
      }
    }
  }

  return { command, unknownFlags };
}

// ─── Main dispatch ───────────────────────────────────────────────────────────

export interface MainOptions {
  fs?: CliFs;
  env?: NodeJS.ProcessEnv;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export const runMain = async (
  opts: MainOptions,
  argv: string[],
): Promise<number> => {
  const {
    fs = createRealFs(),
    env = process.env,
    stdout = (s: string) => console.log(s),
    stderr = (s: string) => console.error(s),
  } = opts;

  // Intercept --help/-h before anything else
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(stdout);
    return 0;
  }

  // Extract command and detect unknown flags before parseArgs
  const { command, unknownFlags } = extractCommand(argv);

  if (unknownFlags.length > 0) {
    stderr(`omd: unknown option ${unknownFlags[0]}`);
    stderr("Run 'omd --help' for usage.");
    return 2;
  }

  // Default to install for bare `omd`
  const resolvedCommand = command ?? 'install';

  try {
    switch (resolvedCommand) {
    case 'install': {
      // Remaining argv for parseArgs to extract options
      const remaining = argv.slice(
        argv.indexOf('install') + 1 || argv.indexOf(resolvedCommand) + 1,
      );
      const { values } = parseArgs({
        argv: remaining,
        allowPositionals: true,
        strict: false,
        options: {
          'dry-run': { type: 'boolean', default: false },
          version: { type: 'string', default: undefined },
          latest: { type: 'boolean', default: false },
          yes: { type: 'boolean', default: false },
        },
      });
      const installOpts: InstallOptions = {
        version: values['latest'] ? 'latest' : String(values['version'] ?? ''),
        dryRun: Boolean(values['dry-run']),
        yes: Boolean(values['yes']),
      };
      const result = runInstall(installOpts, fs, env);
      if (result.status === 'skipped') {
        stdout('omd: already installed (no changes needed)');
        return 0;
      }
      for (const r of result.results) {
        if (r.status === 'wrote') {
          stdout(`omd: registered in ${r.path}`);
        } else if (r.status === 'skipped') {
          stdout(`omd: ${r.path} — already up to date`);
        }
      }
      return 0;
    }

    case 'uninstall': {
      const remaining = argv.slice(argv.indexOf(resolvedCommand) + 1);
      const { values } = parseArgs({
        argv: remaining,
        allowPositionals: true,
        strict: false,
        options: {
          'dry-run': { type: 'boolean', default: false },
          purge: { type: 'boolean', default: false },
          yes: { type: 'boolean', default: false },
        },
      });
      const uninstallOpts: UninstallOptions = {
        purge: Boolean(values['purge']),
        dryRun: Boolean(values['dry-run']),
        yes: Boolean(values['yes']),
      };
      const result = runUninstall(uninstallOpts, fs, env);
      if (result.status === 'skipped') {
        stdout('omd: not installed (no changes needed)');
        return 0;
      }
      for (const r of result.results) {
        if (r.status === 'wrote') {
          stdout(`omd: removed from ${r.path}`);
        } else if (r.status === 'skipped') {
          stdout(`omd: ${r.path} — not present`);
        }
      }
      if (result.purged) {
        stdout('omd: cache purged');
      }
      return 0;
    }

    case 'status': {
      await runStatus(fs, env, stdout);
      return 0;
    }

    case 'doctor': {
      const docResult = await runDoctor(fs, env, stdout, stderr);
      return docResult.ok ? 0 : 1;
    }

    case 'update': {
      const remaining = argv.slice(argv.indexOf(resolvedCommand) + 1);
      const { values } = parseArgs({
        argv: remaining,
        allowPositionals: true,
        strict: false,
        options: {
          'dry-run': { type: 'boolean', default: false },
        },
      });
      const dryRun = Boolean(values['dry-run']);
      const updateResult = await runUpdate(fs, env, stdout, stderr, { dryRun });
      if (updateResult.status === 'current') {
        stdout('omd: already at latest version');
      }
      return 0;
    }

    default:
      stderr(`omd: unknown command '${resolvedCommand}'`);
      stderr("Run 'omd --help' for usage.");
      return 2;
  }
  } catch (err) {
    stderr(`omd: ${(err as Error).message}`);
    return 1;
  }
};

// ─── Entry point ─────────────────────────────────────────────────────────────
// Only run when executed directly (not imported as a module in tests).
const isMainModule =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMainModule) {
  const exitCode = await runMain({}, process.argv.slice(2));
  process.exit(exitCode);
}
