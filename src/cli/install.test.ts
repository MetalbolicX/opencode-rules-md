/**
 * Tests for the install command.
 *
 * Covers: fresh install to both server and TUI configs, idempotent re-run,
 * dry-run, malformed config abort (throws), dedupe behavior, backup creation,
 * backup rotation, version replacement, and TUI config handling.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { saveEnv, restoreEnv, type EnvSnapshot } from '../test-fixtures.js';
import type { CliFs } from './real-fs.js';
import { runInstall } from './install.js';
import { SERVER_CONFIG_FILENAME, TUI_CONFIG_FILENAME } from './config.js';

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
// Helpers
// ---------------------------------------------------------------------------

const SERVER_PATH = `/home/user/.config/opencode/${SERVER_CONFIG_FILENAME}`;
const TUI_PATH = `/home/user/.config/opencode/${TUI_CONFIG_FILENAME}`;

function seedConfig(fs: InMemoryCliFs, content: string): void {
  fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
  fs.writeFileSync(SERVER_PATH, content);
}

function seedTuiConfig(fs: InMemoryCliFs, content: string): void {
  fs.mkdirSync('/home/user/.config/opencode', { recursive: true });
  fs.writeFileSync(TUI_PATH, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runInstall', () => {
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

  it('writes opencode-rules-md to both server and TUI configs on fresh install', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    expect(result.specifier).toBe('opencode-rules-md');
    expect(result.server.status).toBe('wrote');
    expect(result.server.path).toBe(SERVER_PATH);
    expect(result.tui.status).toBe('wrote');
    expect(result.tui.path).toBe(TUI_PATH);

    const serverWritten = fs.readFileSync(SERVER_PATH);
    expect(serverWritten).toContain('"plugin"');
    expect(serverWritten).toContain('opencode-rules-md');

    const tuiWritten = fs.readFileSync(TUI_PATH);
    expect(tuiWritten).toContain('"plugin"');
    expect(tuiWritten).toContain('opencode-rules-md');
  });

  it('creates server config file if it does not exist', () => {
    const fs = new InMemoryCliFs();
    fs.mkdirSync('/home/user/.config/opencode', { recursive: true });

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    expect(fs.existsSync(SERVER_PATH)).toBe(true);
    expect(fs.existsSync(TUI_PATH)).toBe(true);
  });

  it('returns noop when already installed in both configs with same specifier', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));
    seedTuiConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));

    const result = runInstall({}, fs);

    expect(result.status).toBe('noop');
    expect(result.server.status).toBe('noop');
    expect(result.tui.status).toBe('noop');

    // Should not have duplicate entries
    const matches = fs.readFileSync(SERVER_PATH).match(/"opencode-rules-md"/g);
    expect(matches?.length).toBe(1);
  });

  it('returns wrote when only server config has the plugin', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));
    // TUI config does not exist

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    expect(result.server.status).toBe('noop');
    expect(result.tui.status).toBe('wrote');
  });

  it('returns wrote when only TUI config has the plugin', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['other-plugin'] }));
    seedTuiConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md'] }));

    const result = runInstall({}, fs);

    expect(result.status).toBe('wrote');
    expect(result.server.status).toBe('wrote');
    expect(result.tui.status).toBe('noop');
  });

  it('replaces existing opencode-rules-md with new version when version differs', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md@0.1.0'] }));
    seedTuiConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md@0.1.0'] }));

    const result = runInstall({ version: '0.2.0' }, fs);

    expect(result.status).toBe('wrote');
    expect(fs.readFileSync(SERVER_PATH)).toContain('opencode-rules-md@0.2.0');
    expect(fs.readFileSync(SERVER_PATH)).not.toContain('opencode-rules-md@0.1.0');
    expect(fs.readFileSync(TUI_PATH)).toContain('opencode-rules-md@0.2.0');
    expect(fs.readFileSync(TUI_PATH)).not.toContain('opencode-rules-md@0.1.0');
  });

  it('dry-run returns planned without writing either config', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = runInstall({ dryRun: true }, fs);

    expect(result.status).toBe('planned');
    expect(result.server.status).toBe('planned');
    expect(result.tui.status).toBe('planned');
    // Server config should be unchanged
    expect(fs.readFileSync(SERVER_PATH)).toBe('{}');
  });

  it('throws when server config is malformed', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{ invalid json }');

    expect(() => runInstall({}, fs)).toThrow(/opencode.json is malformed/);
    // Original config should be untouched
    expect(fs.readFileSync(SERVER_PATH)).toBe('{ invalid json }');
  });

  it('throws when TUI config is malformed', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');
    seedTuiConfig(fs, '{ invalid json }');

    expect(() => runInstall({}, fs)).toThrow(/tui.json is malformed/);
  });

  it('creates backups before writing each config', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['other-plugin'] }));
    seedTuiConfig(fs, JSON.stringify({ plugin: ['other-plugin'] }));

    const result = runInstall({}, fs);

    expect(result.server.backup).toBeDefined();
    expect(fs.existsSync(result.server.backup!)).toBe(true);
    expect(fs.readFileSync(result.server.backup!)).toContain('other-plugin');

    expect(result.tui.backup).toBeDefined();
    expect(fs.existsSync(result.tui.backup!)).toBe(true);
  });

  it('removes existing opencode-rules-md entries before adding new specifier', () => {
    const fs = new InMemoryCliFs();
    seedConfig(
      fs,
      JSON.stringify({ plugin: ['opencode-rules-md@0.1.0', 'some-other-plugin'] })
    );
    seedTuiConfig(fs, JSON.stringify({ plugin: ['opencode-rules-md@0.1.0'] }));

    const result = runInstall({ version: '0.2.0' }, fs);

    expect(result.status).toBe('wrote');
    expect(fs.readFileSync(SERVER_PATH)).toContain('some-other-plugin');
    expect(fs.readFileSync(SERVER_PATH)).toContain('opencode-rules-md@0.2.0');
    expect(fs.readFileSync(SERVER_PATH)).not.toContain('opencode-rules-md@0.1.0');
    expect(fs.readFileSync(TUI_PATH)).toContain('opencode-rules-md@0.2.0');
    expect(fs.readFileSync(TUI_PATH)).not.toContain('opencode-rules-md@0.1.0');
  });

  it('appends specifier with version when version option is provided', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, '{}');

    const result = runInstall({ version: '1.2.3' }, fs);

    expect(result.specifier).toBe('opencode-rules-md@1.2.3');
    expect(fs.readFileSync(SERVER_PATH)).toContain('opencode-rules-md@1.2.3');
    expect(fs.readFileSync(TUI_PATH)).toContain('opencode-rules-md@1.2.3');
  });

  it('rotates server backups, keeping at most 3', () => {
    const fs = new InMemoryCliFs();
    seedConfig(fs, JSON.stringify({ plugin: ['p1'] }));

    // Create 3 existing backups
    fs.writeFileSync(`${SERVER_PATH}.bak.1`, 'backup1');
    fs.writeFileSync(`${SERVER_PATH}.bak.2`, 'backup2');
    fs.writeFileSync(`${SERVER_PATH}.bak.3`, 'backup3');

    runInstall({ version: '1.0.0' }, fs);

    // Oldest (bak.1) should be deleted
    expect(fs.existsSync(`${SERVER_PATH}.bak.1`)).toBe(false);
    expect(fs.existsSync(`${SERVER_PATH}.bak.2`)).toBe(true);
    expect(fs.existsSync(`${SERVER_PATH}.bak.3`)).toBe(true);
  });

  it('preserves unrelated plugins in both configs', () => {
    const fs = new InMemoryCliFs();
    seedConfig(
      fs,
      JSON.stringify({ plugin: ['opencode-agent-skills', 'opencode-smart-router@latest'] })
    );
    seedTuiConfig(fs, JSON.stringify({ plugin: ['other-tui-plugin'] }));

    runInstall({}, fs);

    const serverWritten = fs.readFileSync(SERVER_PATH);
    expect(serverWritten).toContain('opencode-agent-skills');
    expect(serverWritten).toContain('opencode-smart-router@latest');
    expect(serverWritten).toContain('opencode-rules-md');

    const tuiWritten = fs.readFileSync(TUI_PATH);
    expect(tuiWritten).toContain('other-tui-plugin');
    expect(tuiWritten).toContain('opencode-rules-md');
  });
});