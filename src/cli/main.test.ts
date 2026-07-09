/**
 * Tests for the CLI main entrypoint.
 *
 * Uses in-memory CliFs to avoid real filesystem access.
 * Covers: install dispatch, status dispatch, unknown command,
 * --help, --version, --latest, --dry-run, --yes, exit codes.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { saveEnv, restoreEnv, type EnvSnapshot } from '../test-fixtures.js';
import type { CliFs } from './real-fs.js';
import { runMain } from './main.js';

// ---------------------------------------------------------------------------
// In-memory CliFs (same pattern as install.test.ts)
// ---------------------------------------------------------------------------

class InMemoryCliFs implements CliFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>(['/']);

  readFileSync(p: string): string {
    const content = this.files.get(p);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${p}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    return content;
  }

  writeFileSync(p: string, content: string): void {
    const dir = p.substring(0, p.lastIndexOf('/') || 1);
    if (!this.dirs.has(dir)) {
      const err = new Error(`ENOENT: ${dir}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    this.files.set(p, content);
  }

  renameSync(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${from}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    this.files.delete(from);
    this.files.set(to, content);
  }

  copyFileSync(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${from}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    this.files.set(to, content);
  }

  unlinkSync(p: string): void {
    this.files.delete(p);
  }

  mkdirSync(p: string, opts?: { recursive?: boolean }): void {
    if (opts?.recursive) {
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        this.dirs.add('/' + parts.slice(0, i).join('/'));
      }
    } else {
      this.dirs.add(p);
    }
  }

  readdirSync(p: string): string[] {
    if (!this.dirs.has(p)) {
      const err = new Error(`ENOENT: ${p}`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    const result: string[] = [];
    for (const file of this.files.keys()) {
      const lastSlash = file.lastIndexOf('/');
      const dir = lastSlash === -1 ? '' : file.substring(0, lastSlash);
      if (dir === p || (p === '/' && lastSlash === 0)) {
        result.push(file.substring(lastSlash + 1));
      }
    }
    return result;
  }

  existsSync(p: string): boolean {
    if (this.files.has(p)) return true;
    if (this.dirs.has(p)) return true;
    for (const file of this.files.keys()) {
      if (file.startsWith(p + '/')) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeConfigPath(): string {
  return '/home/user/.config/opencode/opencode.json';
}

function seedConfig(fs: InMemoryCliFs, content: string): void {
  const configPath = makeConfigPath();
  fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
  fs.writeFileSync(configPath, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMain', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = saveEnv();
    process.env.HOME = '/home/user';
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('dispatches install command and returns 0 on success', async () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = await runMain(['install'], fs);

    expect(result).toBe(0);
    const configPath = makeConfigPath();
    const written = fs.readFileSync(configPath);
    expect(written).toContain('opencode-rules');
  });

  it('creates config file if install command finds none', async () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });

    const result = await runMain(['install'], fs);

    expect(result).toBe(0);
    const configPath = makeConfigPath();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('dispatches status command and returns 0', async () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
    fs.writeFileSync(makeConfigPath(), JSON.stringify({ plugin: ['opencode-rules'] }));

    const result = await runMain(['status'], fs);

    expect(result).toBe(0);
  });

  it('status command returns 0 even when not installed', async () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });

    const result = await runMain(['status'], fs);

    expect(result).toBe(0);
  });

  it('returns 2 for unknown command', async () => {
    const fs = new InMemoryCliFs();

    const result = await runMain(['unknown-cmd'], fs);

    expect(result).toBe(2);
  });

  it('parses --version flag and returns 0', async () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = await runMain(['install', '--version', '1.2.3'], fs);

    expect(result).toBe(0);
    const configPath = makeConfigPath();
    expect(fs.readFileSync(configPath)).toContain('opencode-rules@1.2.3');
  });

  it('parses --dry-run flag and returns 0 without writing', async () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = await runMain(['install', '--dry-run'], fs);

    expect(result).toBe(0);
    // Config should be unchanged
    expect(fs.readFileSync(makeConfigPath())).toBe('{}');
  });

  it('parses --yes flag and returns 0', async () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = await runMain(['install', '--yes'], fs);

    expect(result).toBe(0);
    expect(fs.readFileSync(makeConfigPath())).toContain('opencode-rules');
  });

  it('parses -h and returns 0 (help)', async () => {
    const fs = new InMemoryCliFs();

    const result = await runMain(['install', '-h'], fs);

    expect(result).toBe(0);
  });

  it('parses --help and returns 0', async () => {
    const fs = new InMemoryCliFs();

    const result = await runMain(['install', '--help'], fs);

    expect(result).toBe(0);
  });

  it('accepts --latest flag and returns 0', async () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = await runMain(['install', '--latest'], fs);

    expect(result).toBe(0);
  });
});
