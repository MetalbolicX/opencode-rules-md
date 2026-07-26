// ---------------------------------------------------------------------------
// src/cli/build-cli.test.ts — Smoke test for the CLI build artifact.
//
// Verifies that `dist/cli.mjs` exists, is a valid executable shebang, and
// responds to --help with exit code 0 and usage text containing "omd".
//
// The CI workflow does not run `bun run build`, so dist/cli.mjs may be
// absent in CI. The whole suite is gated on the artifact existing so the
// suite is **skipped** (not failed) when the bundle is missing, and runs
// normally when present locally.
// ---------------------------------------------------------------------------

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const CLI_PATH = resolve(import.meta.dirname, '../../dist/cli.mjs');
const cliBundlePresent = existsSync(CLI_PATH);
const describeCli = cliBundlePresent ? describe : describe.skip;

describeCli('CLI build artifact', () => {
  // ── File existence ────────────────────────────────────────────────────────

  it('dist/cli.mjs exists after build', () => {
    const exists = existsSync(CLI_PATH);
    expect(exists).toBe(true);
  });

  // ── Shebang ────────────────────────────────────────────────────────────────

  it('starts with #!/usr/bin/env node shebang', () => {
    const content = readFileSync(CLI_PATH, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  // ── Executable mode (POSIX) ─────────────────────────────────────────────────

  it('has exec bits set (mode includes 0o100 on POSIX)', () => {
    const stat = statSync(CLI_PATH);
    const isExecutable = (stat.mode & 0o100) !== 0;
    expect(isExecutable).toBe(true);
  });

  // ── Functional smoke: --help ───────────────────────────────────────────────

  it('dist/cli.mjs --help exits 0 and prints usage containing omd', () => {
    // Ensure exec bits are set (needed in some environments where the build
    // script chmod may not have persisted).
    try {
      chmodSync(CLI_PATH, 0o755);
    } catch {
      // chmod failures are non-fatal in the build script; skip here too.
    }

    const result = spawnSync(process.argv[0] ?? 'node', [CLI_PATH, '--help'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('omd');
  });
});
