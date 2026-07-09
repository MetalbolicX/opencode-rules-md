#!/usr/bin/env node
/**
 * CLI entrypoint for opencode-rules installer.
 *
 * Supports:
 *   install   — add opencode-rules to the global opencode config
 *   status    — report whether opencode-rules is installed
 *
 * Flags:
 *   --version <v>  — specify a plugin version to install
 *   --latest       — install the latest version (default)
 *   --dry-run      — show what would be written, without changing files
 *   --yes          — skip confirmation prompts (future use)
 *   -h, --help     — show this help text
 */

import { parseArgs } from 'node:util';
import { runInstall } from './install.js';
import { runStatus } from './status.js';
import type { CliFs } from './real-fs.js';
import { realFs } from './real-fs.js';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `opencode-rules CLI

Usage: opencode-rules <command> [options]

Commands:
  install   Add opencode-rules to the global opencode config
  status    Report whether opencode-rules is installed

Options:
  --version <v>  Specify a plugin version to install
  --latest       Install the latest version (default)
  --dry-run      Show what would be written, without changing files
  --yes          Skip confirmation prompts (future use)
  -h, --help     Show this help text
`.trim();

const USAGE_ERROR_TEXT = `Error: unknown command. Run 'opencode-rules --help' for usage.
`.trim();

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

  // Detect unknown flags (tokens that look like flags but aren't recognized)
  // parseArgs already filters known tokens, so we check if any positional
  // looks like an unknown option
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
        const installResult = runInstall(installOpts, fs);
        // Map install status to exit code
        if (installResult.status === 'error') {
          return 1;
        }
        return 0;
      }

      case 'status': {
        const statusResult = runStatus(fs);
        // Print status to stdout
        if (statusResult.installed) {
          console.log(`opencode-rules is installed (${statusResult.specifier})`);
        } else {
          console.log('opencode-rules is not installed');
        }
        // Exit code 0 regardless of install state (status is read-only)
        return 0;
      }

      default: {
        console.error(`Error: unknown command '${command}'`);
        console.error(USAGE_ERROR_TEXT);
        return 2;
      }
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Only run if executed directly (not imported as a module)
if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runMain(process.argv.slice(2));
  process.exit(exitCode);
}
