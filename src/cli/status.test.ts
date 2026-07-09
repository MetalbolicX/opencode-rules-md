/**
 * Tests for the status command.
 *
 * Covers: installed yes/no, specifier reporting, config path reporting,
 * version reporting, malformed config handling.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { saveEnv, restoreEnv, type EnvSnapshot } from '../test-fixtures.js';
import type { CliFs } from './real-fs.js';
import { runStatus } from './status.js';

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

describe('runStatus', () => {
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

  it('reports installed=true with specifier and path when opencode-rules is present', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules@0.6.5'] }));

    const result = runStatus(fs);

    expect(result.installed).toBe(true);
    expect(result.specifier).toBe('opencode-rules@0.6.5');
    expect(result.path).toBe(makeConfigPath(fs));
  });

  it('reports installed=false when no config exists', () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
    expect(result.specifier).toBeUndefined();
  });

  it('reports installed=false when config exists but plugin array is empty', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: [] }));

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
  });

  it('reports installed=false when opencode-rules is not in plugin list', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['some-other-plugin'] }));

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
  });

  it('surfaces parseError and returns installed=false for malformed config', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{ invalid json }');

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
    expect(result.parseError).toBeDefined();
  });

  it('reports installed=false when config has no plugin key', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ otherKey: 'value' }));

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
  });

  it('returns the bundled version', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules'] }));

    const result = runStatus(fs);

    // Version should come from package.json — 0.6.5 is the current version
    expect(result.version).toBeTruthy();
    expect(typeof result.version).toBe('string');
  });
});
