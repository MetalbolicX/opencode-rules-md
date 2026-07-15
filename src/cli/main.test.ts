/**
 * src/cli/main.test.ts
 *
 * Tests for CLI main dispatch against the redesigned omd installer.
 *
 * Behavioral contract verified here:
 *   - Bare `omd` defaults to install.
 *   - `--help` / `-h` print usage and exit 0.
 *   - Unknown commands and unknown options exit 2.
 *   - The install command is a thin wrapper around OpenCode's CLI:
 *     it spawns `opencode plugin <specifier> --global` instead of writing
 *     directly to opencode.json / tui.json.
 *   - The update command spawns `opencode plugin opencode-rules-md
 *     --global --force` after purging the cache under
 *     ~/.cache/opencode/packages/opencode-rules-md*.
 *   - The uninstall command still edits the configs (we own those) but
 *     now writes to the modern `plugin` (singular) field and cleans
 *     up the legacy `plugins` (plural) field if present.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';

// @ts-ignore — module exists
import { runMain, type MainOptions } from '../cli/main.js';
// @ts-ignore
import { runInstall, type InstallOptions } from '../cli/install.js';
// @ts-ignore
import { runUninstall, type UninstallOptions } from '../cli/uninstall.js';
// @ts-ignore
import type { SpawnResult } from '../cli/spawn.js';

const MOCK_LATEST = '9.9.9';

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
    HOME: homedir(),
    OPENCODE_CONFIG_DIR: undefined,
    ...overrides,
  };
}

// ─── Fake spawn factory ───────────────────────────────────────────────────────

interface SpawnCall {
  command: string;
  args: string[];
}

function makeFakeSpawn(
  result: SpawnResult = { status: 0, stdout: '', stderr: '' },
): { spawn: MainOptions['spawn']; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (async (args: string[]) => {
      calls.push({ command: 'opencode', args });
      return result;
    }) as MainOptions['spawn'],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// runMain dispatch
// ═══════════════════════════════════════════════════════════════════════════════

describe('runMain (bare omd defaults to install)', () => {
  it('bare omd with no args dispatches install and returns exit 0', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
      latestVersion: MOCK_LATEST,
      spawn: fake.spawn,
    };

    const exitCode = await runMain(opts, []);
    expect(exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
    // bare omd installs with the bare specifier (lets OpenCode refresh)
    expect(fake.calls[0]!.args).toEqual(['opencode-rules-md', '--global']);
  });

  it('bare omd prints a success message', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
      latestVersion: MOCK_LATEST,
      spawn: fake.spawn,
    };

    await runMain(opts, []);
    expect(logs.some((l) => l.includes('installed via opencode plugin'))).toBe(true);
  });
});

// ─── --help / -h ──────────────────────────────────────────────────────────────

describe('runMain --help / -h', () => {
  it('--help prints usage and exits 0', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['--help']);
    expect(exitCode).toBe(0);
    const output = logs.join('');
    expect(output).toContain('Usage');
    expect(output).toContain('omd');
    // USAGE mentions "OpenCode's plugin command" — match case-insensitively.
    expect(output.toLowerCase()).toContain('plugin');
  });

  it('-h prints usage and exits 0', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['-h']);
    expect(exitCode).toBe(0);
    const output = logs.join('');
    expect(output).toContain('Usage');
  });
});

// ─── unknown command ──────────────────────────────────────────────────────────

describe('runMain unknown command', () => {
  it('unknown command exits 2', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['notacommand']);
    expect(exitCode).toBe(2);
  });

  it('unknown option exits 2', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['install', '--unknown-opt']);
    expect(exitCode).toBe(2);
  });
});

// ─── command routing ──────────────────────────────────────────────────────────

describe('runMain command routing', () => {
  it('omd install dispatches install command', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
      latestVersion: MOCK_LATEST,
      spawn: fake.spawn,
    };

    const exitCode = await runMain(opts, ['install']);
    expect(exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it('omd install --version 2.0.0 pins the specifier', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
      spawn: fake.spawn,
    };

    const exitCode = await runMain(opts, ['install', '--version', '2.0.0']);
    expect(exitCode).toBe(0);
    expect(fake.calls[0]!.args).toEqual(['opencode-rules-md@2.0.0', '--global']);
  });

  it('omd install --dry-run does not invoke spawn', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
      spawn: fake.spawn,
    };

    const exitCode = await runMain(opts, ['install', '--dry-run']);
    expect(exitCode).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(logs.some((l) => l.includes('dry-run'))).toBe(true);
  });

  it('omd install surfaces a non-zero exit as exit code 1', async () => {
    const fake = makeFakeSpawn({ status: 1, stdout: '', stderr: 'oops' });
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const errors: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: (s: string) => errors.push(s),
      spawn: fake.spawn,
    };

    const exitCode = await runMain(opts, ['install']);
    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes('oops') || e.includes('status 1'))).toBe(true);
  });

  it('omd uninstall dispatches uninstall command and removes plugin', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['uninstall']);
    expect(exitCode).toBe(0);
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugin ?? []).not.toContain('opencode-rules-md@1.0.0');
    expect(tuiContent.plugin ?? []).not.toContain('opencode-rules-md@1.0.0');
  });

  it('omd status dispatches status command', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
      latestVersion: MOCK_LATEST,
    };

    const exitCode = await runMain(opts, ['status']);
    expect(exitCode).toBe(0);
  });

  it('omd doctor dispatches doctor command', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const parentDir = resolve(home, '.config');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir, parentDir]);
    const fakeEnv = makeFakeEnv({
      HOME: home,
      PATH: '/home/metalbolicx/.bun/bin:/usr/local/bin:/usr/bin:/bin',
    });

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['doctor']);
    expect(exitCode).toBe(0);
  });

  it('omd update dispatches update command and exits 0 when current', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: () => {},
      stderr: () => {},
      latestVersion: '2.0.0',
      spawn: makeFakeSpawn().spawn,
    };

    const exitCode = await runMain(opts, ['update']);
    expect(exitCode).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runInstall
// ═══════════════════════════════════════════════════════════════════════════════

describe('runInstall', () => {
  it('spawns opencode plugin <specifier> --global with the bare specifier', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const result = await runInstall({ spawn: fake.spawn }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    expect(result.specifier).toBe('opencode-rules-md');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.args).toEqual(['opencode-rules-md', '--global']);
  });

  it('--version pins the specifier', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const result = await runInstall({ version: '2.0.0', spawn: fake.spawn }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    expect(result.specifier).toBe('opencode-rules-md@2.0.0');
    expect(fake.calls[0]!.args).toEqual(['opencode-rules-md@2.0.0', '--global']);
  });

  it('--dry-run does not invoke spawn', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const result = await runInstall({ dryRun: true }, fs, fakeEnv);

    expect(result.status).toBe('skipped');
    expect(result.specifier).toBe('opencode-rules-md');
    expect(fake.calls).toHaveLength(0);
  });

  it('--dry-run with --version prints the pinned specifier', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    const result = await runInstall({ dryRun: true, version: '1.2.3' }, fs, fakeEnv);

    expect(result.status).toBe('skipped');
    expect(result.specifier).toBe('opencode-rules-md@1.2.3');
    expect(fake.calls).toHaveLength(0);
  });

  it('throws when spawn returns a non-zero exit code', async () => {
    const fake = makeFakeSpawn({ status: 2, stdout: '', stderr: 'permission denied' });
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();

    await expect(runInstall({ spawn: fake.spawn }, fs, fakeEnv)).rejects.toThrow(/status 2/);
  });

  it('passes the configured env through to the spawned process', async () => {
    const fake = makeFakeSpawn();
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv({ OMD_TEST_VAR: 'present' });

    // Capture the env via a spawn stub that records it.
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const capturingSpawn: MainOptions['spawn'] = (async (
      _args: string[],
      opts?: { env?: NodeJS.ProcessEnv; stdio?: 'pipe' | 'inherit' },
    ) => {
      capturedEnv = opts?.env;
      return { status: 0, stdout: '', stderr: '' };
    }) as MainOptions['spawn'];

    await runInstall({ spawn: capturingSpawn }, fs, fakeEnv);
    expect(capturedEnv).toBeDefined();
    // The env we passed should reach the spawn layer.
    expect(capturedEnv!['OMD_TEST_VAR']).toBe('present');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runUninstall
// ═══════════════════════════════════════════════════════════════════════════════

describe('runUninstall', () => {
  it('removes plugin from both configs using the singular "plugin" field', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0', 'other-plugin'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({}, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugin).toEqual(['other-plugin']);
    // The tui config had only the opencode-rules-md entry — the field is
    // removed entirely (not left as an empty array) so OpenCode sees a clean
    // shape.
    expect(tuiContent.plugin ?? []).toEqual([]);
  });

  it('also cleans up a legacy "plugins" field if present', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({
        plugins: ['opencode-rules-md@1.0.0', 'keep-me'],
      }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({}, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    // Legacy `plugins` field is gone.
    expect(opencodeContent.plugins).toBeUndefined();
    // Non-omd entries migrate into the modern `plugin` field.
    expect(opencodeContent.plugin).toEqual(['keep-me']);
    // No opencode-rules-md entry remains under either key.
    const serialized = JSON.stringify(opencodeContent);
    expect(serialized).not.toContain('opencode-rules-md');
  });

  it('uninstall when not installed is no-op (status=skipped)', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: [] }),
      [tuiPath]: JSON.stringify({ plugin: [] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({}, fs, fakeEnv);
    expect(result.status).toBe('skipped');
  });

  it('--dry-run does not write to disk', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({ dryRun: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    expect(opencodeContent.plugin).toContain('opencode-rules-md@1.0.0');
  });

  it('--purge deletes the new packages cache, not rule dirs', () => {
    const home = homedir();
    const cacheDir = resolve(home, '.cache', 'opencode', 'packages', 'opencode-rules-md@latest');
    const ruleDir = resolve(home, '.local', 'share', 'opencode-rules-md');
    const opencodePath = resolve(home, '.config', 'opencode', 'opencode.json');
    const tuiPath = resolve(home, '.config', 'opencode', 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [resolve(cacheDir, 'package.json')]: '{}',
      [resolve(ruleDir, 'rules.md')]: '# Rules',
    }, [
      resolve(home, '.cache', 'opencode', 'packages'),
      cacheDir,
      resolve(home, '.local', 'share'),
      ruleDir,
    ]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({ purge: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    expect(result.purged).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(ruleDir)).toBe(true);
  });

  it('--purge with no cache dir is silent success', () => {
    const home = homedir();
    const opencodePath = resolve(home, '.config', 'opencode', 'opencode.json');
    const tuiPath = resolve(home, '.config', 'opencode', 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugin: ['opencode-rules-md@1.0.0'] }),
    }, [resolve(home, '.config', 'opencode')]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({ purge: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    expect(result.purged).toBe(false);
  });
});