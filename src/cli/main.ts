#!/usr/bin/env node
/**
 * CLI entrypoint for opencode-rules-md installer.
 *
 * Supports:
 *   install   — add opencode-rules-md to the global opencode + tui configs
 *   status    — report whether opencode-rules-md is installed
 *
 * Flags:
 *   --version <v>  — specify a plugin version to install
 *   --latest       — install the latest version (default)
 *   --dry-run      — show what would be written, without changing files
 *   --yes          — skip confirmation prompts (future use)
 *   -h, --help     — show this help text
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { runInstall } from './install.js';
import { runStatus } from './status.js';
import type { CliFs } from './real-fs.js';
import { realFs } from './real-fs.js';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `opencode-rules-md CLI

Usage: opencode-rules-md <command> [options]

Commands:
  install   Add opencode-rules-md to the global opencode + tui configs
  status    Report whether opencode-rules-md is installed

Options:
  --version <v>  Specify a plugin version to install
  --latest       Install the latest version (default)
  --dry-run      Show what would be written, without changing files
  --yes          Skip confirmation prompts (future use)
  -h, --help     Show this help text
`.trim();

const USAGE_ERROR_TEXT = `Error: unknown command. Run 'opencode-rules-md --help' for usage.`.trim();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  version?: string;
  latest?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  help?: boolean;
}

function parseCliArgs(argv: string[]): { command: string | null; options: CliOptions; unknownFlags: string[] } {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      latest: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      h: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  // Extract command (first positional)
  const command = positionals[0] ?? null;

  // Extract options from parsed values
  // Note: -h sets key 'h', --help sets key 'help'
  const options: CliOptions = {
    ...(values.version !== undefined && { version: values.version as string }),
    ...(values.latest && { latest: true }),
    ...(values['dry-run'] && { dryRun: true }),
    ...(values.yes && { yes: true }),
    ...((values.help || values.h) && { help: true }),
  };

  const unknownFlags: string[] = [];

  return { command, options, unknownFlags };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type ExitCode = 0 | 1 | 2;

export async function runMain(argv: string[], fs: CliFs = realFs): Promise<ExitCode> {
  try {
    const { command, options, unknownFlags } = parseCliArgs(argv);

    // Handle help flag at top level (before command dispatch)
    if (options.help) {
      console.log(HELP_TEXT);
      return 0;
    }

    // Handle unknown flags
    if (unknownFlags.length > 0) {
      console.error(`Error: unknown option(s): ${unknownFlags.join(', ')}`);
      console.error(USAGE_ERROR_TEXT);
      return 2;
    }

    // No command given
    if (!command) {
      console.error(USAGE_ERROR_TEXT);
      return 2;
    }

    switch (command) {
      case 'install': {
        const installOpts: { version?: string; dryRun?: boolean } = {};
        if (options.version !== undefined) installOpts.version = options.version;
        if (options.dryRun) installOpts.dryRun = true;
        runInstall(installOpts, fs);
        return 0;
      }
      case 'status': {
        const statusResult = runStatus(fs);
        if (statusResult.installed) {
          const spec = statusResult.serverSpecifier ?? statusResult.tuiSpecifier;
          console.log(`opencode-rules-md is installed (${spec})`);
        } else {
          console.log('opencode-rules-md is not installed');
        }
        return 0;
      }
      default: {
        console.error(`Error: unknown command '${command}'`);
        console.error(USAGE_ERROR_TEXT);
        return 2;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Determine whether the current module is being executed as the main entry.
 * Uses realpathSync + pathToFileURL so symlinked invocations (e.g. npx)
 * are matched correctly.
 */
function isInvokedAsMain(): boolean {
  if (!process.argv[1]) return false;

  try {
    const realArgv = pathToFileURL(realpathSync(process.argv[1])).href;
    return import.meta.url === realArgv;
  } catch {
    try {
      return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
      return false;
    }
  }
}

// Only run if executed directly (not imported as a module)
if (isInvokedAsMain()) {
  void runMain(process.argv.slice(2)).then(code => process.exit(code));
}