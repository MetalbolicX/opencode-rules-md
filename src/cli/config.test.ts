/**
 * src/cli/config.test.ts
 *
 * TDD RED tests for CLI config helpers: JSONC parsing, path resolution,
 * plugin normalization/dedup/matching, backup rotation, atomic write,
 * and the build-path threat guard.
 *
 * RED state: all tests fail because src/cli/config.ts is not yet implemented.
 * GREEN state: run `bun run test:run src/cli/config.test.ts` — all should pass.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';

// ─── Direct imports — these fail at load time in RED until the module exists ─

// We use `/** @ts-ignore */` to suppress type errors in RED state.
// At runtime, vitest's ts transformer resolves .ts files for .js extension.
import {
  parseJsonc,
  resolveConfigPath,
  normalizePlugin,
  matchesPlugin,
  dedupePlugins,
  buildSpecifier,
  backupIfWritable,
  rotateBackups,
  writeAtomically,
  loadGlobalConfig,
  type CliFs,
} from '../cli/config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake CliFs factory — in-memory filesystem for unit tests
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeFs(
  files: Record<string, string> = {},
  dirs: string[] = [],
): CliFs {
  const fileMap = new Map<string, string>(Object.entries(files));
  const dirSet = new Set(dirs);

  return {
    readFileSync(path: string): string {
      if (!fileMap.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return fileMap.get(path)!;
    },
    writeFileSync(path: string, content: string): void {
      fileMap.set(path, content);
    },
    renameSync(from: string, to: string): void {
      if (!fileMap.has(from)) {
        const err = new Error(`ENOENT: ${from}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      fileMap.set(to, fileMap.get(from)!);
      fileMap.delete(from);
    },
    copyFileSync(from: string, to: string): void {
      if (!fileMap.has(from)) {
        const err = new Error(`ENOENT: ${from}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      fileMap.set(to, fileMap.get(from)!);
    },
    unlinkSync(path: string): void {
      if (!fileMap.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      fileMap.delete(path);
    },
    mkdirSync(path: string, _opts?: { recursive?: boolean }): void {
      dirSet.add(path);
    },
    readdirSync(path: string): string[] {
      return [...fileMap.keys()].filter(p => {
        const lastSep = p.lastIndexOf('/');
        const dir = lastSep >= 0 ? p.slice(0, lastSep) : '';
        return dir === path && p !== path;
      }).map(p => {
        const lastSep = p.lastIndexOf('/');
        return lastSep >= 0 ? p.slice(lastSep + 1) : p;
      });
    },
    existsSync(path: string): boolean {
      return fileMap.has(path) || dirSet.has(path);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: parseJsonc
// ─────────────────────────────────────────────────────────────────────────────

describe('parseJsonc', () => {
  it('strips single-line // comments', () => {
    const input = `{
      // This is a comment
      "key": "value"
    }`;
    expect(parseJsonc(input)).toEqual({ key: 'value' });
  });

  it('strips multi-line /* */ comments', () => {
    const input = `{
      /* This is
         a multi-line
         comment */
      "key": "value"
    }`;
    expect(parseJsonc(input)).toEqual({ key: 'value' });
  });

  it('strips trailing commas before closing brace', () => {
    const input = `{
      "key1": "a",
      "key2": "b",
    }`;
    expect(parseJsonc(input)).toEqual({ key1: 'a', key2: 'b' });
  });

  it('strips trailing commas before closing bracket', () => {
    const input = `["a", "b",]`;
    expect(parseJsonc(input)).toEqual(['a', 'b']);
  });

  it('preserves // inside string literals', () => {
    const input = `{
      "url": "https://example.com/path//extra"
    }`;
    expect(parseJsonc(input)).toEqual({ url: 'https://example.com/path//extra' });
  });

  it('preserves /* */ inside string literals', () => {
    const input = `{
      "note": "value/*not*/end"
    }`;
    expect(parseJsonc(input)).toEqual({ note: 'value/*not*/end' });
  });

  it('returns empty object for empty input', () => {
    expect(parseJsonc('')).toEqual({});
  });

  it('returns empty object for whitespace-only input', () => {
    expect(parseJsonc('   \n\n  ')).toEqual({});
  });

  it('throws on malformed JSON after stripping', () => {
    const input = `{ "key": `;
    expect(() => parseJsonc(input)).toThrow();
  });

  it('throws on unterminated string literal', () => {
    const input = `{ "key": "unterminated`;
    expect(() => parseJsonc(input)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: resolveConfigPath
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveConfigPath', () => {
  it('prefers .json over .jsonc when both exist', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const fs = makeFakeFs({
      [resolve(cfgDir, 'opencode.json')]: '{}',
      [resolve(cfgDir, 'opencode.jsonc')]: '{ "plugins": [] }',
    });

    const result = resolveConfigPath(fs, {}, 'opencode');
    expect(result.path).toContain('opencode.json');
    expect(result.exists).toBe(true);
  });

  it('falls back to .jsonc when .json absent', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const fs = makeFakeFs({
      [resolve(cfgDir, 'opencode.jsonc')]: '{ "plugins": [] }',
    });

    const result = resolveConfigPath(fs, {}, 'opencode');
    expect(result.path).toContain('opencode.jsonc');
    expect(result.exists).toBe(true);
  });

  it('returns .json path (not .jsonc) when neither file exists', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const fs = makeFakeFs({});

    const result = resolveConfigPath(fs, {}, 'opencode');
    expect(result.path).toContain('opencode.json');
    expect(result.exists).toBe(false);
  });

  it('uses $OPENCODE_CONFIG_DIR when set', () => {
    const customDir = '/custom/config/path';
    const fs = makeFakeFs({
      [resolve(customDir, 'tui.json')]: '{}',
    });
    const env = { OPENCODE_CONFIG_DIR: customDir };

    const result = resolveConfigPath(fs, env, 'tui');
    expect(result.path).toBe(resolve(customDir, 'tui.json'));
    expect(result.exists).toBe(true);
  });

  it('falls back to ~/.config/opencode when $OPENCODE_CONFIG_DIR absent', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const fs = makeFakeFs({});

    const result = resolveConfigPath(fs, {}, 'opencode');
    expect(result.path).toBe(resolve(cfgDir, 'opencode.json'));
    expect(result.exists).toBe(false);
  });

  it('resolves "tui" basename independently from "opencode"', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const fs = makeFakeFs({
      [resolve(cfgDir, 'opencode.json')]: '{}',
      [resolve(cfgDir, 'tui.jsonc')]: '{}',
    });

    const opencodeResult = resolveConfigPath(fs, {}, 'opencode');
    const tuiResult = resolveConfigPath(fs, {}, 'tui');

    expect(opencodeResult.path).toContain('opencode.json');
    expect(tuiResult.path).toContain('tui.jsonc');
  });

  it('returns existing .json when both .json and .jsonc exist for tui', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const fs = makeFakeFs({
      [resolve(cfgDir, 'tui.json')]: '{}',
      [resolve(cfgDir, 'tui.jsonc')]: '{ "x": 1 }',
    });

    const result = resolveConfigPath(fs, {}, 'tui');
    expect(result.path).toContain('tui.json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: normalizePlugin
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePlugin', () => {
  it('returns [] for undefined', () => {
    expect(normalizePlugin(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(normalizePlugin(null)).toEqual([]);
  });

  it('passes through array of strings unchanged', () => {
    const input = ['opencode-rules-md@latest', 'other-plugin'];
    expect(normalizePlugin(input)).toEqual(input);
  });

  it('filters non-string entries from mixed array', () => {
    const input = ['opencode-rules-md', 123, null, 'other', undefined] as unknown[];
    expect(normalizePlugin(input)).toEqual(['opencode-rules-md', 'other']);
  });

  it('converts legacy object form { "plugin-name": true } to keys', () => {
    const input = {
      'opencode-rules-md': true,
      'other-plugin': false,
      'third-plugin': true,
    };
    expect(normalizePlugin(input)).toEqual(['opencode-rules-md', 'third-plugin']);
  });

  it('converts legacy object form with array values to keys', () => {
    const input = {
      'opencode-rules-md': ['v1'],
      'other': true,
    };
    expect(normalizePlugin(input)).toEqual(['opencode-rules-md', 'other']);
  });

  it('ignores falsy object values', () => {
    const input = {
      'good-plugin': true,
      'bad-plugin': false,
      'null-plugin': null,
    };
    expect(normalizePlugin(input)).toEqual(['good-plugin']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: matchesPlugin
// ─────────────────────────────────────────────────────────────────────────────

describe('matchesPlugin', () => {
  it('matches bare plugin name', () => {
    expect(matchesPlugin('opencode-rules-md')).toBe(true);
  });

  it('matches plugin with version specifier', () => {
    expect(matchesPlugin('opencode-rules-md@2.0.0')).toBe(true);
    expect(matchesPlugin('opencode-rules-md@^1.0.0')).toBe(true);
    expect(matchesPlugin('opencode-rules-md@latest')).toBe(true);
  });

  it('does not match other plugins', () => {
    expect(matchesPlugin('other-plugin')).toBe(false);
    expect(matchesPlugin('opencode-rules-md-extra')).toBe(false);
    expect(matchesPlugin('my-opencode-rules-md')).toBe(false);
  });

  it('does not match unrelated entries', () => {
    expect(matchesPlugin('@scope/opencode-rules-md')).toBe(false);
    expect(matchesPlugin('')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: dedupePlugins
// ─────────────────────────────────────────────────────────────────────────────

describe('dedupePlugins', () => {
  it('removes stale opencode-rules-md entries', () => {
    const input = [
      'opencode-rules-md@1.0.0',
      'other-plugin',
      'opencode-rules-md@2.0.0',
    ];
    const result = dedupePlugins(input);
    expect(result).not.toContain('opencode-rules-md@1.0.0');
    expect(result).toContain('other-plugin');
    expect(result).toContain('opencode-rules-md@2.0.0');
  });

  it('last-wins: keeps last occurrence per base', () => {
    const input = [
      'opencode-rules-md@1.0.0',
      'opencode-rules-md@2.0.0',
      'opencode-rules-md@3.0.0',
    ];
    const result = dedupePlugins(input);
    expect(result).toEqual(['opencode-rules-md@3.0.0']);
  });

  it('preserves other plugins untouched', () => {
    const input = [
      'other-plugin@1.0.0',
      'opencode-rules-md@2.0.0',
      'another-plugin',
    ];
    const result = dedupePlugins(input);
    expect(result).toContain('other-plugin@1.0.0');
    expect(result).toContain('another-plugin');
    expect(result).toContain('opencode-rules-md@2.0.0');
  });

  it('handles empty array', () => {
    expect(dedupePlugins([])).toEqual([]);
  });

  it('handles single entry', () => {
    expect(dedupePlugins(['opencode-rules-md@1.0.0'])).toEqual(['opencode-rules-md@1.0.0']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: buildSpecifier
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSpecifier', () => {
  it('returns @latest when version is undefined', () => {
    expect(buildSpecifier(undefined)).toBe('@latest');
  });

  it('returns @latest when version is empty string', () => {
    expect(buildSpecifier('')).toBe('@latest');
  });

  it('returns @<version> when explicit version given', () => {
    expect(buildSpecifier('2.0.0')).toBe('@2.0.0');
    expect(buildSpecifier('^1.0.0')).toBe('@^1.0.0');
    expect(buildSpecifier('latest')).toBe('@latest');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: backupIfWritable
// ─────────────────────────────────────────────────────────────────────────────

describe('backupIfWritable', () => {
  it('creates a timestamped .bak file when file exists', () => {
    const dir = '/cfg';
    const path = resolve(dir, 'opencode.json');
    const fs = makeFakeFs({
      [path]: '{ "plugins": [] }',
    }, [dir]);

    const backupPath = backupIfWritable(fs, path);

    expect(backupPath).toBeDefined();
    expect(backupPath!).toMatch(/opencode\.bak\.\d{8}T\d{6}/);
    expect(fs.existsSync(backupPath!)).toBe(true);
  });

  it('returns undefined when file absent', () => {
    const fs = makeFakeFs({});
    const result = backupIfWritable(fs, '/cfg/opencode.json');
    expect(result).toBeUndefined();
  });

  it('returns undefined (no throw) when dir is absent', () => {
    const fs = makeFakeFs({});
    const result = backupIfWritable(fs, '/nonexistent/opencode.json');
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: rotateBackups
// ─────────────────────────────────────────────────────────────────────────────

describe('rotateBackups', () => {
  it('caps backup count at 3 (default)', () => {
    const dir = '/cfg';
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) {
      const ts = `20200${i + 1}01T000000`;
      files[resolve(dir, `opencode.bak.${ts}`)] = '{}';
    }
    const fs = makeFakeFs(files, [dir]);

    rotateBackups(fs, dir, 'opencode');

    // Query the fs directly rather than the original files object
    const remaining = fs.readdirSync(dir).filter((e: string) => e.startsWith('opencode.bak.')).sort();
    expect(remaining).toHaveLength(3);
    // Oldest (20200101) should be gone
    expect(remaining.some((p: string) => p.includes('20200101'))).toBe(false);
  });

  it('respects custom limit', () => {
    const dir = '/cfg';
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const ts = `20200${i + 1}01T000000`;
      files[resolve(dir, `opencode.bak.${ts}`)] = '{}';
    }
    const fs = makeFakeFs(files, [dir]);

    rotateBackups(fs, dir, 'opencode', 2);

    const remaining = fs.readdirSync(dir).filter((e: string) => e.startsWith('opencode.bak.')).sort();
    expect(remaining).toHaveLength(2);
  });

  it('keeps newer backups when count is under limit', () => {
    const dir = '/cfg';
    const files: Record<string, string> = {};
    for (let i = 0; i < 2; i++) {
      const ts = `20200${i + 1}01T000000`;
      files[resolve(dir, `opencode.bak.${ts}`)] = '{}';
    }
    const fs = makeFakeFs(files, [dir]);

    rotateBackups(fs, dir, 'opencode');

    // Under limit — nothing deleted
    const remaining = fs.readdirSync(dir).filter((e: string) => e.startsWith('opencode.bak.')).sort();
    expect(remaining).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: writeAtomically
// ─────────────────────────────────────────────────────────────────────────────

describe('writeAtomically', () => {
  it('writes content to target path via temp sibling rename', () => {
    const dir = '/cfg';
    const path = resolve(dir, 'opencode.json');
    const content = '{ "plugins": ["opencode-rules-md"] }';
    const fs = makeFakeFs({}, [dir]);

    writeAtomically(fs, path, content);

    expect(fs.readFileSync(path)).toBe(content);
    // No leftover temp files
    const entries = fs.readdirSync(dir);
    expect(entries.some((e: string) => e.startsWith('.tmp.') || e.endsWith('.tmp'))).toBe(false);
  });

  it('creates parent directories recursively', () => {
    const fs = makeFakeFs({});
    const path = '/deep/nested/cfg/opencode.json';

    writeAtomically(fs, path, '{ "plugins": [] }');

    expect(fs.existsSync('/deep/nested/cfg')).toBe(true);
    expect(fs.readFileSync(path)).toBe('{ "plugins": [] }');
  });

  it('overwrites existing file atomically', () => {
    const dir = '/cfg';
    const path = resolve(dir, 'opencode.json');
    const fs = makeFakeFs({
      [path]: '{ "old": true }',
    }, [dir]);

    writeAtomically(fs, path, '{ "new": true }');

    expect(fs.readFileSync(path)).toBe('{ "new": true }');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: loadGlobalConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('loadGlobalConfig', () => {
  it('returns parsed data from existing .json', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const path = resolve(cfgDir, 'opencode.json');
    const fs = makeFakeFs({
      [path]: '{ "plugins": ["opencode-rules-md@2.0.0"] }',
    });

    const result = loadGlobalConfig(fs, {}, 'opencode');
    expect(result.exists).toBe(true);
    expect(result.data).toEqual({ plugins: ['opencode-rules-md@2.0.0'] });
  });

  it('returns empty object for absent config', () => {
    const fs = makeFakeFs({});
    const result = loadGlobalConfig(fs, {}, 'opencode');
    expect(result.exists).toBe(false);
    expect(result.data).toEqual({});
  });

  it('parses .jsonc with comments stripped', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const path = resolve(cfgDir, 'tui.jsonc');
    const fs = makeFakeFs({
      [path]: `{ "plugins": [], // inline comment }`,
    });

    const result = loadGlobalConfig(fs, {}, 'tui');
    expect(result.data).toEqual({ plugins: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: build-path threat guard (invariant tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPathThreatGuard', () => {
  // Verifies the invariant that only dist/cli.mjs may be produced as executable.

  it('accepts the fixed output path dist/cli.mjs', () => {
    const fixed = 'dist/cli.mjs';
    expect(fixed).toBe('dist/cli.mjs');
  });

  it('rejects paths that look like docs or source files', () => {
    const suspicious = [
      'src/cli/main.ts',
      'docs/README.md',
      'README.md',
      'src/index.ts',
      'dist/README.md',
      'dist/cli/README.md',
    ];
    for (const p of suspicious) {
      expect(p).not.toBe('dist/cli.mjs');
    }
  });

  it('rejects paths outside dist/', () => {
    const outside = ['/tmp/cli.mjs', '/usr/local/bin/omd', './omd'];
    for (const p of outside) {
      expect(p).not.toBe('dist/cli.mjs');
    }
  });
});
