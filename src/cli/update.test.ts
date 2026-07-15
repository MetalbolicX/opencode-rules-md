/**
 * src/cli/update.test.ts
 *
 * Tests for the redesigned `omd update` command.
 *
 * Behavioral contract verified here:
 *   - When stale, the command purges the actual OpenCode packages cache
 *     (under ~/.cache/opencode/packages/opencode-rules-md*) and then
 *     spawns `opencode plugin opencode-rules-md --global --force`.
 *   - When current, the command reports "already at latest" without any
 *     side effects.
 *   - --dry-run prints the planned purge + spawn without touching disk.
 *   - When the npm registry is unreachable, status is `unreachable` and
 *     no spawn happens.
 *   - The result shape exposes `cachePaths` (plural, array) so callers
 *     can clean up multiple matching directories.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';

// @ts-ignore — module exists
import { runUpdate, type UpdateResult } from '../cli/update.js';
// @ts-ignore
import type { SpawnResult } from '../cli/spawn.js';

const FAKE_HOME = '/tmp/omd-update-test-home';

// ─── Fake CliFs factory ──────────────────────────────────────────────────────

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
      // File children: files directly in `path`.
      const fileChildren = [...fileMap.keys()]
        .filter(p => {
          const lastSep = p.lastIndexOf('/');
          const dir = lastSep >= 0 ? p.slice(0, lastSep) : '';
          return dir === path && p !== path;
        })
        .map(p => {
          const lastSep = p.lastIndexOf('/');
          return lastSep >= 0 ? p.slice(lastSep + 1) : p;
        });
      // Directory children: dirs in dirSet whose parent is `path`.
      const dirChildren = [...dirSet]
        .filter(d => {
          if (d === path) return false;
          const lastSep = d.lastIndexOf('/');
          const parent = lastSep >= 0 ? d.slice(0, lastSep) : '';
          return parent === path;
        })
        .map(d => {
          const lastSep = d.lastIndexOf('/');
          return lastSep >= 0 ? d.slice(lastSep + 1) : d;
        });
      return [...new Set([...fileChildren, ...dirChildren])];
    },
    existsSync(path: string): boolean {
      return fileMap.has(path) || dirSet.has(path);
    },
  };
}

// ─── Fake env factory ─────────────────────────────────────────────────────────

function makeFakeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HOME: FAKE_HOME,
    OPENCODE_CONFIG_DIR: undefined,
    ...overrides,
  };
}

// ─── Fake spawn factory ───────────────────────────────────────────────────────

interface SpawnCall {
  args: string[];
}

function makeFakeSpawn(result: SpawnResult = { status: 0, stdout: '', stderr: '' }): {
  spawn: import('./update.js').UpdateOptions['spawn'];
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (async (args: string[]) => {
      calls.push({ args });
      return result;
    }) as import('./update.js').UpdateOptions['spawn'],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function logFn(output: string[]): (s: string) => void {
  return (s: string) => {
    output.push(s);
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// runUpdate
// ═══════════════════════════════════════════════════════════════════════════════

describe('runUpdate', () => {
  it('stale version: purges the packages cache and spawns --force', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');
    const packagesDir = resolve(FAKE_HOME, '.cache', 'opencode', 'packages');
    const cacheDir = resolve(packagesDir, 'opencode-rules-md@latest');
    const cachePackage = resolve(cacheDir, 'package.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [cachePackage]: JSON.stringify({ version: '1.0.0' }),
    }, [packagesDir, cacheDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const fake = makeFakeSpawn();

    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', spawn: fake.spawn },
    )) as UpdateResult;

    expect(result.status).toBe('stale');
    expect(fs.existsSync(cacheDir)).toBe(false);
    // spawn was called once with the --force flag.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.args).toEqual(['opencode-rules-md', '--global', '--force']);
  });

  it('current version: reports "already current" and does NOT spawn', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const fake = makeFakeSpawn();

    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', spawn: fake.spawn },
    )) as UpdateResult;

    expect(result.status).toBe('current');
    expect(fake.calls).toHaveLength(0);
    const output = logs.join(' ');
    expect(output.toLowerCase()).toMatch(/already|latest/);
  });

  it('--dry-run: does NOT purge or spawn', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const packagesDir = resolve(FAKE_HOME, '.cache', 'opencode', 'packages');
    const cacheDir = resolve(packagesDir, 'opencode-rules-md@latest');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [resolve(cacheDir, 'package.json')]: JSON.stringify({ version: '1.0.0' }),
    }, [packagesDir, cacheDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const fake = makeFakeSpawn();

    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', dryRun: true, spawn: fake.spawn },
    )) as UpdateResult;

    expect(result.status).toBe('stale');
    // Cache still present in dry-run.
    expect(fs.existsSync(cacheDir)).toBe(true);
    // Spawn was not invoked.
    expect(fake.calls).toHaveLength(0);
    const output = logs.join(' ').toLowerCase();
    expect(output).toMatch(/dry|would/);
  });

  it('registry unreachable: returns "unreachable" and does NOT spawn', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const fake = makeFakeSpawn();

    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: null, spawn: fake.spawn },
    )) as UpdateResult;

    expect(result.status).toBe('unreachable');
    expect(fake.calls).toHaveLength(0);
  });

  it('returns UpdateResult with cachePaths (plural, array) and instruction', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', spawn: makeFakeSpawn().spawn },
    )) as UpdateResult;

    expect(result.status).toBeDefined();
    expect(Array.isArray(result.cachePaths)).toBe(true);
    expect(result.cachePaths.length).toBeGreaterThan(0);
    // Every path lives under ~/.cache/opencode/packages/.
    for (const p of result.cachePaths) {
      expect(p).toContain('.cache/opencode/packages/');
    }
    expect(typeof result.instruction).toBe('string');
  });

  it('legacy "plugins" field is still honored for installed version lookup', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      // A user upgrading from the old buggy `omd install` would have this.
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    // The installed version from the legacy field should still trigger stale detection.
    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', spawn: makeFakeSpawn().spawn },
    )) as UpdateResult;

    expect(result.status).toBe('stale');
  });

  it('purges multiple matching cache directories (bare + @latest)', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const packagesDir = resolve(FAKE_HOME, '.cache', 'opencode', 'packages');
    const cacheDir1 = resolve(packagesDir, 'opencode-rules-md');
    const cacheDir2 = resolve(packagesDir, 'opencode-rules-md@latest');
    const cacheDir3 = resolve(packagesDir, 'opencode-rules-md@1.0.0');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [resolve(cacheDir1, 'package.json')]: '{}',
      [resolve(cacheDir2, 'package.json')]: '{}',
      [resolve(cacheDir3, 'package.json')]: '{}',
    }, [packagesDir, cacheDir1, cacheDir2, cacheDir3]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const fake = makeFakeSpawn();

    await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', spawn: fake.spawn },
    );

    // All three matching dirs should be gone (the unrelated plugin dir would still be here).
    expect(fs.existsSync(cacheDir1)).toBe(false);
    expect(fs.existsSync(cacheDir2)).toBe(false);
    expect(fs.existsSync(cacheDir3)).toBe(false);
  });

  it('throws when spawn exits non-zero', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const packagesDir = resolve(FAKE_HOME, '.cache', 'opencode', 'packages');
    const cacheDir = resolve(packagesDir, 'opencode-rules-md@latest');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [resolve(cacheDir, 'package.json')]: '{}',
    }, [packagesDir, cacheDir]);

    const fakeEnv = makeFakeEnv();
    const fake = makeFakeSpawn({ status: 3, stdout: '', stderr: 'boom' });

    await expect(
      runUpdate(
        fs,
        fakeEnv,
        () => {},
        () => {},
        { latestVersion: '2.0.0', spawn: fake.spawn },
      ),
    ).rejects.toThrow(/status 3/);
  });

  it('treats no installed version as stale', async () => {
    const cfgDir = resolve(FAKE_HOME, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const fake = makeFakeSpawn();

    const result = (await runUpdate(
      fs,
      fakeEnv,
      logFn(logs),
      () => {},
      { latestVersion: '2.0.0', spawn: fake.spawn },
    )) as UpdateResult;

    expect(result.status).toBe('stale');
    expect(fake.calls).toHaveLength(1);
  });
});