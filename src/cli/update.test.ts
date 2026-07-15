/**
 * src/cli/update.test.ts
 *
 * TDD RED tests for CLI update command.
 * - stale version triggers purge + instruction print
 * - current version says "already current"
 * - --dry-run prints planned purge
 * - registry unreachable → noop
 * - fetches npm latest for opencode-rules-md
 *
 * RED state: run `bun run test:run src/cli/update.test.ts` — tests fail because
 * src/cli/update.ts does not exist yet.
 * GREEN state: all tests pass once update.ts is implemented.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';

// ─── Direct imports — fail at load time in RED until modules exist ───────────

// @ts-ignore — module not yet written
import { runUpdate } from '../cli/update.js';
// @ts-ignore — types not yet written
import type { UpdateResult } from '../cli/update.js';

// ─── Fake CliFs factory (mirrors config.test.ts and main.test.ts) ─────────────

function makeFakeFs(
  files: Record<string, string> = {},
  dirs: string[] = [],
) {
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
    rmdirSync(path: string): void {
      if (!dirSet.has(path)) {
        const err = new Error(`ENOENT: ${path}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      dirSet.delete(path);
      for (const key of [...fileMap.keys()]) {
        if (key === path || key.startsWith(path + '/')) {
          fileMap.delete(key);
        }
      }
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

// ─── Fake env factory ─────────────────────────────────────────────────────────

function makeFakeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HOME: homedir(),
    OPENCODE_CONFIG_DIR: undefined,
    ...overrides,
  };
}

// ─── Fake console output tracker ─────────────────────────────────────────────

interface ConsoleOutput {
  logs: string[];
  errors: string[];
}

function makeConsole(): ConsoleOutput {
  return { logs: [], errors: [] };
}

// Helper: wrap array in a log function for passing to runUpdate
function logFn(output: string[]): (s: string) => void {
  return (s: string) => { output.push(s); };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: runUpdate
// ═══════════════════════════════════════════════════════════════════════════════

describe('runUpdate', () => {
  it('stale version triggers cache purge and prints reinstall instruction', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');
    const cacheDir = resolve(home, '.cache', 'opencode', 'node_modules', 'opencode-rules-md');
    const cachePackage = resolve(cacheDir, 'package.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [cachePackage]: JSON.stringify({ version: '1.0.0' }),
    }, [
      resolve(home, '.cache', 'opencode', 'node_modules'),
      cacheDir,
    ]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    // Simulate latest = 2.0.0 (stale case)
    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0' },
    ) as UpdateResult;

    // Should have purged the cache
    expect(result.status).toBe('stale');
    expect(fs.existsSync(cacheDir)).toBe(false);

    // Should have printed the reinstall instruction
    const output = console_.logs.join(' ');
    expect(output).toContain('npx opencode-rules-md@latest install');
  });

  it('current version says "already current"', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    // Simulate latest = 2.0.0 (current case)
    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0' },
    ) as UpdateResult;

    expect(result.status).toBe('current');
    const output = console_.logs.join(' ');
    expect(output).toMatch(/current|already|up.to.date/i);
  });

  it('--dry-run prints planned purge without removing cache', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');
    const cacheDir = resolve(home, '.cache', 'opencode', 'node_modules', 'opencode-rules-md');
    const cachePackage = resolve(cacheDir, 'package.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [cachePackage]: JSON.stringify({ version: '1.0.0' }),
    }, [
      resolve(home, '.cache', 'opencode', 'node_modules'),
      cacheDir,
    ]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    // Simulate latest = 2.0.0 with dry-run
    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0', dryRun: true },
    ) as UpdateResult;

    expect(result.status).toBe('stale');
    // Cache should still exist in dry-run
    expect(fs.existsSync(cacheDir)).toBe(true);
    // Should have printed dry-run indicator
    const output = console_.logs.join(' ');
    expect(output.toLowerCase()).toMatch(/dry|would|purge/);
  });

  it('registry unreachable → noop', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    // Simulate registry unreachable (null latest)
    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: null },
    ) as UpdateResult;

    expect(result.status).toBe('unreachable');
    // Should not have thrown
    expect(console_.errors.length).toBe(0);
  });

  it('returns UpdateResult with status, cachePath, and instruction', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0' },
    ) as UpdateResult;

    expect(result.status).toBeDefined();
    expect(result.cachePath).toBeDefined();
    expect(typeof result.cachePath).toBe('string');
    expect(result.instruction).toBeDefined();
  });

  it('cachePath points to the expected cache directory', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0' },
    ) as UpdateResult;

    const expectedCachePath = resolve(home, '.cache', 'opencode', 'node_modules', 'opencode-rules-md');
    expect(result.cachePath).toBe(expectedCachePath);
  });

  it('instruction contains npx opencode-rules-md@latest install when stale', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');
    const cacheDir = resolve(home, '.cache', 'opencode', 'node_modules', 'opencode-rules-md');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [
      resolve(home, '.cache', 'opencode', 'node_modules'),
      cacheDir,
    ]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0' },
    ) as UpdateResult;

    expect(result.instruction).toContain('npx opencode-rules-md@latest install');
  });

  it('purges cache and prints instruction when installed version is older', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');
    const cacheDir = resolve(home, '.cache', 'opencode', 'node_modules', 'opencode-rules-md');
    const cacheFile = resolve(cacheDir, 'index.js');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [cacheFile]: '// old version',
    }, [
      resolve(home, '.cache', 'opencode', 'node_modules'),
      cacheDir,
    ]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    // latest > installed
    const result = await runUpdate(
      fs,
      fakeEnv,
      logFn(console_.logs),
      logFn(console_.errors),
      { latestVersion: '2.0.0' },
    ) as UpdateResult;

    expect(result.status).toBe('stale');
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(console_.logs.some(l => l.includes('npx opencode-rules-md@latest install'))).toBe(true);
  });
});
