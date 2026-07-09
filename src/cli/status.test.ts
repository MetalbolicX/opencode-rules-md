/**
 * Tests for the status command.
 *
 * Covers: installed yes/no across both configs, specifier reporting for
 * server and TUI, config path reporting, version reporting,
 * malformed config handling.
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
    if (this.dirs.has(p)) return true;
    for (const file of this.files.keys()) {
      if (file.startsWith(p + '/')) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_PATH = '/home/user/.config/opencode/opencode.json';
const TUI_PATH = '/home/user/.config/opencode/tui.json';

function seedServer(fs: InMemoryCliFs, content: string): void {
  fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
  fs.writeFileSync(SERVER_PATH, content);
}

function seedTui(fs: InMemoryCliFs, content: string): void {
  fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
  fs.writeFileSync(TUI_PATH, content);
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

  it('reports installed=true when present in both server and TUI configs', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, JSON.stringify({ plugin: ['opencode-rules-md@0.6.5'] }));
    seedTui(fs, JSON.stringify({ plugin: ['opencode-rules-md@0.6.5'] }));

    const result = runStatus(fs);

    expect(result.installed).toBe(true);
    expect(result.serverSpecifier).toBe('opencode-rules-md@0.6.5');
    expect(result.tuiSpecifier).toBe('opencode-rules-md@0.6.5');
    expect(result.serverPath).toBe(SERVER_PATH);
    expect(result.tuiPath).toBe(TUI_PATH);
  });

  it('reports installed=false when missing from server config', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, JSON.stringify({ plugin: ['other-plugin'] }));
    seedTui(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
    expect(result.serverSpecifier).toBeUndefined();
    expect(result.tuiSpecifier).toBe('opencode-rules-md');
  });

  it('reports installed=false when missing from TUI config', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));
    // TUI config does not exist

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
    expect(result.serverSpecifier).toBe('opencode-rules-md');
    expect(result.tuiSpecifier).toBeUndefined();
  });

  it('reports installed=false when no config exists', () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
    expect(result.serverSpecifier).toBeUndefined();
    expect(result.tuiSpecifier).toBeUndefined();
  });

  it('reports installed=false when configs exist but plugin arrays are empty', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, JSON.stringify({ plugin: [] }));
    seedTui(fs, JSON.stringify({ plugin: [] }));

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
  });

  it('surfaces parseError and returns installed=false for malformed server config', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, '{ invalid json }');

    const result = runStatus(fs);

    expect(result.installed).toBe(false);
    expect(result.parseError).toBeDefined();
  });

  it('reports version from package.json', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));
    seedTui(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));

    const result = runStatus(fs);

    expect(result.version).toBeTruthy();
    expect(typeof result.version).toBe('string');
  });

  it('reports both config paths even when only one has the plugin', () => {
    const fs = new InMemoryCliFs();
    seedServer(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));
    seedTui(fs, JSON.stringify({ plugin: [] }));

    const result = runStatus(fs);

    expect(result.serverPath).toBe(SERVER_PATH);
    expect(result.tuiPath).toBe(TUI_PATH);
    expect(result.serverExisted).toBe(true);
    expect(result.tuiExisted).toBe(true);
  });
});