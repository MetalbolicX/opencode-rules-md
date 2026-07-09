/**
 * Tests for CLI config helpers: discovery, JSONC parsing, plugin normalization,
 * backup rotation, and atomic write.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { saveEnv, restoreEnv, type EnvSnapshot } from '../test-fixtures.js';
import type { CliFs } from './real-fs.js';

// In-memory CliFs for tests — all state lives in a Map.
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
      // Normalize: compare both with and without trailing slash
      const normalizedDir = dir === p || dir + '/' === p || dir === p + '/';
      if (normalizedDir) {
        result.push(file.substring(lastSlash + 1));
      }
    }
    return result;
  }

  existsSync(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }

  /** Seed a file directly for test setup */
  seedFile(path: string, content: string): void {
    const dir = path.substring(0, path.lastIndexOf('/') || 1);
    this.mkdirSync(dir, { recursive: true });
    this.files.set(path, content);
  }

  /** Return all files matching a prefix */
  listFiles(prefix: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const [k, v] of this.files) {
      if (k.startsWith(prefix)) {
        result.set(k, v);
      }
    }
    return result;
  }

  clear(): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add('/');
  }
}

// ---------------------------------------------------------------------------
// Imports of the module under test — dynamically so we can re-import after
// resetting module state between test suites.
// ---------------------------------------------------------------------------
import * as configModule from './config.js';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------
let memFs: InMemoryCliFs;
let savedEnv: EnvSnapshot;

function reimport(): typeof configModule {
  // Clear the module cache so we get a fresh instance with the new memFs
  // We do this by clearing the import cache and re-importing.
  // Since the module is side-effect free we can simply re-use the same instance
  // if we pass the fs in via a setter. Instead, we refactored config.ts to
  // accept fs via its factory / setter — but for simplicity in this test
  // file we just re-import after re-instantiating the module cache clear.
  return configModule;
}

beforeEach(() => {
  memFs = new InMemoryCliFs();
  savedEnv = saveEnv('OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME', 'APPDATA');
  // Seed a basic home so fallback paths work
  memFs.seedFile('/home/user/.config/opencode/opencode.json', '{}');
});

afterEach(() => {
  restoreEnv(savedEnv);
});

// ---------------------------------------------------------------------------
// JSONC parsing
// ---------------------------------------------------------------------------
describe('JSONC strip', () => {
  it('strips single-line comments', () => {
    const result = configModule.stripJsoncComments(
      '{// comment\n"a":"b"}'
    );
    expect(result).toBe('{\n"a":"b"}');
  });

  it('strips multi-line comments', () => {
    const result = configModule.stripJsoncComments(
      '{/* block */"x":1}'
    );
    expect(result).toBe('{"x":1}');
  });

  it('strips trailing commas before closing brace', () => {
    const result = configModule.stripJsoncComments('{"a":"b",}');
    expect(result).toBe('{"a":"b"}');
  });

  it('strips trailing commas before closing bracket', () => {
    const result = configModule.stripJsoncComments('["a","b",]');
    expect(result).toBe('["a","b"]');
  });

  it('preserves comment-like sequences inside string values', () => {
    const result = configModule.stripJsoncComments(
      '{"url":"https://x//y"}'
    );
    expect(result).toBe('{"url":"https://x//y"}');
  });

  it('preserves // inside string values', () => {
    const result = configModule.stripJsoncComments(
      '{"msg":"hello // world"}'
    );
    expect(result).toBe('{"msg":"hello // world"}');
  });

  it('preserves /* */ inside string values', () => {
    const result = configModule.stripJsoncComments(
      '{"msg":"/* block comment */"}'
    );
    expect(result).toBe('{"msg":"/* block comment */"}');
  });

  it('handles real-world JSONC with interspersed comments', () => {
    const jsonc = `{
  // this is a comment
  "plugin": [
    "plugin-a" // trailing
  ],
  /* top-level block */
  "version": 1
}`;
    const result = configModule.stripJsoncComments(jsonc);
    // Should be valid JSON after stripping
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({
      plugin: ['plugin-a'],
      version: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------
describe('resolveGlobalConfigPath', () => {
  it('returns OPENCODE_CONFIG_DIR/opencode.json when set', () => {
    process.env.OPENCODE_CONFIG_DIR = '/custom/config';
    const result = configModule.resolveGlobalConfigPath(memFs);
    expect(result).toBe('/custom/config/opencode.json');
  });

  it('falls back to XDG_CONFIG_HOME/opencode/opencode.json', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = '/xdg/config';
    const result = configModule.resolveGlobalConfigPath(memFs);
    expect(result).toBe('/xdg/config/opencode/opencode.json');
  });

  it('falls back to HOME/.config/opencode/opencode.json', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/home/user';
    const result = configModule.resolveGlobalConfigPath(memFs);
    expect(result).toBe('/home/user/.config/opencode/opencode.json');
  });

  it('creates parent dir when install=true and dir missing', () => {
    const mem = new InMemoryCliFs();
    mem.clear();
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/home/user';
    // No dir exists yet
    expect(mem.existsSync('/home/user/.config/opencode')).toBe(false);
    configModule.resolveGlobalConfigPath(mem, { ensureDir: true });
    expect(mem.existsSync('/home/user/.config/opencode')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plugin normalization / dedupe
// ---------------------------------------------------------------------------
describe('normalizePlugin', () => {
  it('returns empty array for missing plugin key', () => {
    expect(configModule.normalizePlugin({})).toEqual([]);
  });

  it('returns empty array for null plugin', () => {
    expect(configModule.normalizePlugin({ plugin: null })).toEqual([]);
  });

  it('returns empty array for undefined plugin', () => {
    expect(configModule.normalizePlugin({ plugin: undefined })).toEqual([]);
  });

  it('returns deduplicated plugin list keeping last occurrence', () => {
    const result = configModule.normalizePlugin({
      plugin: ['plugin-a', 'plugin-b', 'plugin-a'],
    });
    expect(result).toEqual(['plugin-b', 'plugin-a']);
  });

  it('returns deduplicated list with opencode-rules-md variants', () => {
    const result = configModule.normalizePlugin({
      plugin: [
        'opencode-rules-md',
        'opencode-rules-md@0.1.0',
        'plugin-a',
        'opencode-rules-md',
      ],
    });
    // Dedupe by prefix match, keeping the last occurrence
    expect(result).toEqual(['plugin-a', 'opencode-rules-md']);
  });
});

describe('addPlugin', () => {
  it('adds opencode-rules-md when plugin array is empty', () => {
    const obj = { plugin: [] as string[] };
    configModule.addPlugin(obj, 'opencode-rules-md');
    expect(obj.plugin).toEqual(['opencode-rules-md']);
  });

  it('adds opencode-rules-md when plugin is missing', () => {
    const obj = {};
    configModule.addPlugin(obj, 'opencode-rules-md');
    expect((obj as { plugin?: string[] }).plugin).toEqual(['opencode-rules-md']);
  });

  it('does not duplicate existing opencode-rules-md', () => {
    const obj = { plugin: ['opencode-rules-md', 'plugin-a'] };
    configModule.addPlugin(obj, 'opencode-rules-md');
    expect(obj.plugin).toEqual(['plugin-a', 'opencode-rules-md']);
  });

  it('appends opencode-rules-md at the end', () => {
    const obj = { plugin: ['plugin-a', 'plugin-b'] };
    configModule.addPlugin(obj, 'opencode-rules-md');
    expect(obj.plugin).toEqual(['plugin-a', 'plugin-b', 'opencode-rules-md']);
  });
});

describe('removePlugin', () => {
  it('removes opencode-rules-md entries by prefix', () => {
    const obj = { plugin: ['opencode-rules-md', 'opencode-rules-md@0.1.0', 'plugin-a'] };
    configModule.removePlugin(obj, 'opencode-rules-md');
    expect(obj.plugin).toEqual(['plugin-a']);
  });

  it('leaves plugin unchanged when none match', () => {
    const obj = { plugin: ['plugin-a', 'plugin-b'] };
    configModule.removePlugin(obj, 'opencode-rules-md');
    expect(obj.plugin).toEqual(['plugin-a', 'plugin-b']);
  });

  it('handles missing plugin key gracefully', () => {
    const obj = {};
    configModule.removePlugin(obj, 'opencode-rules-md');
    expect(obj).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Backup rotation
// ---------------------------------------------------------------------------
describe('rotateBackups', () => {
  it('writes a .bak file when none exist', () => {
    const configPath = '/cfg/opencode.json';
    memFs.seedFile(configPath, '{}');
    const result = configModule.rotateBackups(memFs, configPath, 'opencode-rules-md');
    const files = memFs.listFiles('/cfg/');
    const bakFiles = [...files.keys()].filter(k => k.includes('.bak.'));
    expect(bakFiles).toHaveLength(1);
    expect(result).toBe(bakFiles[0]);
  });

  it('keeps exactly 3 backups', () => {
    const configPath = '/cfg/opencode.json';
    memFs.seedFile(configPath, '{}');
    // Create 3 existing backups
    memFs.seedFile('/cfg/opencode.json.bak.1', 'v1');
    memFs.seedFile('/cfg/opencode.json.bak.2', 'v2');
    memFs.seedFile('/cfg/opencode.json.bak.3', 'v3');
    configModule.rotateBackups(memFs, configPath, 'opencode-rules-md');
    const files = [...memFs.listFiles('/cfg/').keys()];
    const bakFiles = files.filter(k => k.includes('.bak.'));
    expect(bakFiles).toHaveLength(3);
    // Oldest (1) should be removed
    expect(files.some(k => k.endsWith('.bak.1'))).toBe(false);
    expect(files.some(k => k.endsWith('.bak.2'))).toBe(true);
    expect(files.some(k => k.endsWith('.bak.3'))).toBe(true);
  });

  it('deletes the oldest backup when 3 already exist', () => {
    const configPath = '/cfg/opencode.json';
    memFs.seedFile(configPath, '{}');
    memFs.seedFile('/cfg/opencode.json.bak.1', 'oldest');
    memFs.seedFile('/cfg/opencode.json.bak.2', 'middle');
    memFs.seedFile('/cfg/opencode.json.bak.3', 'newest');
    const result = configModule.rotateBackups(memFs, configPath, 'opencode-rules-md');
    const files = [...memFs.listFiles('/cfg/').keys()];
    // Oldest should be deleted
    expect(files.some(k => k.endsWith('.bak.1'))).toBe(false);
    // New backup should be created (timestamp-based, not .bak.4)
    expect(result).toMatch(/\.bak\.\d+/);
    // Should still have exactly 3 backups (2 old + 1 new)
    const bakFiles = files.filter(k => k.includes('.bak.'));
    expect(bakFiles).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------
describe('writeAtomically', () => {
  it('writes content via temp sibling then rename', () => {
    const configPath = '/cfg/opencode.json';
    memFs.seedFile('/cfg/', ''); // ensure dir exists
    configModule.writeAtomically(memFs, configPath, '{"version":1}');
    expect(memFs.readFileSync(configPath)).toBe('{"version":1}');
    // No temp files should remain
    const files = [...memFs.listFiles('/cfg/').keys()];
    expect(files.every(k => !k.includes('.tmp'))).toBe(true);
  });

  it('replaces existing content', () => {
    const configPath = '/cfg/opencode.json';
    memFs.seedFile(configPath, '{}');
    configModule.writeAtomically(memFs, configPath, '{"updated":true}');
    expect(memFs.readFileSync(configPath)).toBe('{"updated":true}');
  });
});

// ---------------------------------------------------------------------------
// loadGlobalConfig
// ---------------------------------------------------------------------------
describe('loadGlobalConfig', () => {
  it('returns existed=false when config does not exist', () => {
    const mem = new InMemoryCliFs();
    mem.clear();
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/home/user';
    const result = configModule.loadGlobalConfig(mem);
    expect(result.existed).toBe(false);
    expect(result.config).toEqual({});
  });

  it('returns existed=true and parsed config when file exists', () => {
    const mem = new InMemoryCliFs();
    mem.seedFile('/home/user/.config/opencode/opencode.json', '{"plugin":["a"]}');
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/home/user';
    const result = configModule.loadGlobalConfig(mem);
    expect(result.existed).toBe(true);
    expect(result.config).toEqual({ plugin: ['a'] });
  });

  it('returns parseError when JSONC stripping yields invalid JSON', () => {
    const mem = new InMemoryCliFs();
    mem.seedFile('/home/user/.config/opencode/opencode.json', '{invalid json}');
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/home/user';
    const result = configModule.loadGlobalConfig(mem);
    expect(result.existed).toBe(true);
    expect(result.parseError).toBeTruthy();
    expect(result.config).toEqual({});
  });

  it('treats comment-only file as empty object', () => {
    const mem = new InMemoryCliFs();
    mem.seedFile('/home/user/.config/opencode/opencode.json', '// only a comment');
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = '/home/user';
    const result = configModule.loadGlobalConfig(mem);
    expect(result.existed).toBe(true);
    expect(result.config).toEqual({});
    expect(result.parseError).toBeUndefined();
  });
});
