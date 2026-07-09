/**
 * Tests for the install command.
 *
 * Covers: fresh install, idempotent re-run, dry-run, malformed config abort,
 * dedupe behavior, backup creation.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { saveEnv, restoreEnv, type EnvSnapshot } from '../test-fixtures.js';
import type { CliFs } from './real-fs.js';
import { runInstall } from './install.js';

// ---------------------------------------------------------------------------
// In-memory CliFs (same pattern as config.test.ts)
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
    // Check if any file path starts with p as a directory prefix
    for (const file of this.files.keys()) {
      if (file.startsWith(p + '/')) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeConfigPath(fs: InMemoryCliFs): string {
  // Simulate ~/.config/opencode/opencode.json
  return '/home/user/.config/opencode/opencode.json';
}

function seedConfig(fs: InMemoryCliFs, content: string): void {
  const configPath = makeConfigPath(fs);
  fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
  fs.writeFileSync(configPath, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInstall', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = saveEnv();
    // Point HOME to a predictable location
    process.env.HOME = '/home/user';
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('writes opencode-rules to a fresh config', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    expect(result.specifier).toBe('opencode-rules');
    const configPath = makeConfigPath(fs);
    expect(result.path).toBe(configPath);
    const written = fs.readFileSync(configPath);
    expect(written).toContain('"plugin"');
    expect(written).toContain('opencode-rules');
  });

  it('creates config file if it does not exist', () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    const configPath = makeConfigPath(fs);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('returns noop when already installed with same specifier', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules'] }));

    const result = runInstall({}, fs);

    expect(result.status).toBe('noop');
    const configPath = makeConfigPath(fs);
    const written = fs.readFileSync(configPath);
    // Should not have duplicate
    const matches = written.match(/"opencode-rules"/g);
    expect(matches?.length).toBe(1);
  });

  it('replaces existing opencode-rules with new version when version differs', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules@0.1.0'] }));

    const result = runInstall({ version: '0.2.0' }, fs);

    expect(result.status).toBe('wrote');
    const configPath = makeConfigPath(fs);
    const written = fs.readFileSync(configPath);
    expect(written).toContain('opencode-rules@0.2.0');
    expect(written).not.toContain('opencode-rules@0.1.0');
  });

  it('dry-run returns planned without writing', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = runInstall({ dryRun: true }, fs);

    expect(result.status).toBe('planned');
    const configPath = makeConfigPath(fs);
    // Config should be unchanged (still empty object)
    expect(fs.readFileSync(configPath)).toBe('{}');
  });

  it('returns parseError when config is malformed', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{ invalid json }');

    const result = runInstall({}, fs);

    expect(result.status).toBe('error');
    expect(result.parseError).toBeDefined();
    const configPath = makeConfigPath(fs);
    // Original should be untouched
    expect(fs.readFileSync(configPath)).toBe('{ invalid json }');
  });

  it('creates a backup before writing', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['other-plugin'] }));

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    expect(result.backup).toBeDefined();
    expect(fs.existsSync(result.backup!)).toBe(true);
    // Backup should contain original content
    expect(fs.readFileSync(result.backup!)).toContain('other-plugin');
  });

  it('removes existing opencode-rules entries before adding', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules@0.1.0', 'some-other-plugin'] }));

    const result = runInstall({ version: '0.2.0' }, fs);

    expect(result.status).toBe('wrote');
    const configPath = makeConfigPath(fs);
    const written = fs.readFileSync(configPath);
    expect(written).toContain('some-other-plugin');
    expect(written).toContain('opencode-rules@0.2.0');
    expect(written).not.toContain('opencode-rules@0.1.0');
  });

  it('appends specifier with version when version option is provided', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = runInstall({ version: '1.2.3' }, fs);

    expect(result.status).toBe('wrote');
    expect(result.specifier).toBe('opencode-rules@1.2.3');
    const configPath = makeConfigPath(fs);
    expect(fs.readFileSync(configPath)).toContain('opencode-rules@1.2.3');
  });

  it('rotates backups, keeping at most 3', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['p1'] }));
    const configPath = makeConfigPath(fs);

    // Create 3 existing backups
    fs.writeFileSync(`${configPath}.bak.1`, 'backup1');
    fs.writeFileSync(`${configPath}.bak.2`, 'backup2');
    fs.writeFileSync(`${configPath}.bak.3`, 'backup3');

    runInstall({ version: '1.0.0' }, fs);

    // Oldest (bak.1) should be deleted
    expect(fs.existsSync(`${configPath}.bak.1`)).toBe(false);
    expect(fs.existsSync(`${configPath}.bak.2`)).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.3`)).toBe(true);
  });
});
