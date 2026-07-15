/**
 * src/cli/main.test.ts
 *
 * TDD RED tests for CLI main dispatch: bare `omd` defaults to install,
 * `--help`/`-h` print usage, unknown command exits 2, parseArgs rejects
 * unknown options, and the command routing to install/uninstall/status/doctor/update.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';

// ─── Direct imports — fail at load time in RED until modules exist ───────────

// @ts-ignore — module not yet written
import { runMain, type MainOptions } from '../cli/main.js';
// @ts-ignore
import { runInstall, type InstallOptions } from '../cli/install.js';
// @ts-ignore
import { runUninstall, type UninstallOptions } from '../cli/uninstall.js';

// ─── Fake CliFs factory (mirrors config.test.ts) ────────────────────────────

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
      // Remove the dir and all files under it
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

// ─── Tests: runMain bare omd → install ───────────────────────────────────────

describe('runMain (bare omd defaults to install)', () => {
  it('bare omd with no args dispatches install and returns exit 0', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const cfgPath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [cfgPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const errors: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: (s: string) => errors.push(s),
    };

    // runMain with no command = install
    const exitCode = await runMain(opts, []);
    expect(exitCode).toBe(0);
  });

  it('bare omd with no args writes plugin to both configs', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    await runMain(opts, []);
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugins).toContain('opencode-rules-md@latest');
    expect(tuiContent.plugins).toContain('opencode-rules-md@latest');
  });
});

// ─── Tests: --help / -h ───────────────────────────────────────────────────────

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
    expect(output).toContain('omd');
  });
});

// ─── Tests: unknown command ──────────────────────────────────────────────────

describe('runMain unknown command', () => {
  it('unknown command exits 2 and prints usage', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const errors: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: (s: string) => errors.push(s),
    };

    const exitCode = await runMain(opts, ['notacommand']);
    expect(exitCode).toBe(2);
  });

  it('unknown option exits 2', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const errors: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: (s: string) => errors.push(s),
    };

    const exitCode = await runMain(opts, ['install', '--unknown-opt']);
    expect(exitCode).toBe(2);
  });

  it('malformed config prints friendly error and exits 1', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs(
      { [opencodePath]: '{ invalid json }' },
      [cfgDir],
    );
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];
    const errors: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: (s: string) => errors.push(s),
    };

    const exitCode = await runMain(opts, ['install']);
    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(opencodePath);
    expect(errors[0]).toContain('malformed JSON');
    expect(errors[0]).toContain('Fix the JSON error');
  });
});

// ─── Tests: command routing ──────────────────────────────────────────────────

describe('runMain command routing', () => {
  it('omd install dispatches install command', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['install']);
    expect(exitCode).toBe(0);
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    expect(opencodeContent.plugins).toContain('opencode-rules-md@latest');
  });

  it('omd uninstall dispatches uninstall command', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['uninstall']);
    expect(exitCode).toBe(0);
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugins).not.toContain('opencode-rules-md@1.0.0');
    expect(tuiContent.plugins).not.toContain('opencode-rules-md@1.0.0');
  });

  it('omd status dispatches status command (stub)', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
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
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir, parentDir]);
    // Set HOME and a fake PATH containing bun so hasBun check passes
    const fakeEnv = makeFakeEnv({ HOME: home, PATH: '/home/metalbolicx/.bun/bin:/usr/local/bin:/usr/bin:/bin' });
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['doctor']);
    // doctor exits 0 when checks pass (Node >= 20, Bun on PATH, configs OK)
    expect(exitCode).toBe(0);
  });

  it('omd update dispatches update command (stub)', async () => {
    const fs = makeFakeFs({}, []);
    const fakeEnv = makeFakeEnv();
    const logs: string[] = [];

    const opts: MainOptions = {
      fs,
      env: fakeEnv,
      stdout: (s: string) => logs.push(s),
      stderr: () => {},
    };

    const exitCode = await runMain(opts, ['update']);
    expect(exitCode).toBe(0);
  });
});

// ─── Tests: runInstall ───────────────────────────────────────────────────────

describe('runInstall', () => {
  it('first install creates plugin entry in both configs', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runInstall({}, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugins).toContain('opencode-rules-md@latest');
    expect(tuiContent.plugins).toContain('opencode-rules-md@latest');
  });

  it('--dry-run does not write to disk', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runInstall({ dryRun: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    // dry-run means nothing hit disk — the file content should be unchanged
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    expect(opencodeContent.plugins).toEqual([]);
  });

  it('--version pins a specific version', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runInstall({ version: '2.0.0' }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    expect(opencodeContent.plugins).toContain('opencode-rules-md@2.0.0');
  });

  it('same-version reinstall is no-op (status=skipped)', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runInstall({ version: '2.0.0' }, fs, fakeEnv);

    expect(result.status).toBe('skipped');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    // still exactly one entry
    expect(opencodeContent.plugins).toEqual(['opencode-rules-md@2.0.0']);
    expect(tuiContent.plugins).toEqual(['opencode-rules-md@2.0.0']);
  });

  it('dedup removes stale entries before appending fresh specifier', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0', 'other-plugin'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runInstall({ version: '2.0.0' }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugins).toEqual(['other-plugin', 'opencode-rules-md@2.0.0']);
    expect(tuiContent.plugins).toEqual(['opencode-rules-md@2.0.0']);
  });

  it('$schema is preserved in tui.json', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [tuiPath]: JSON.stringify({ $schema: './tui.schema.json', plugins: [] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    runInstall({}, fs, fakeEnv);

    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(tuiContent.$schema).toBe('./tui.schema.json');
    expect(tuiContent.plugins).toContain('opencode-rules-md@latest');
  });

  it('--latest uses @latest specifier', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    runInstall({ version: 'latest' }, fs, fakeEnv);

    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    expect(opencodeContent.plugins).toContain('opencode-rules-md@latest');
  });

  it('malformed JSON in config aborts without writing', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: '{ invalid json }',
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    expect(() => runInstall({}, fs, fakeEnv)).toThrow();
  });
});

// ─── Tests: runUninstall ─────────────────────────────────────────────────────

describe('runUninstall', () => {
  it('removes plugin from both configs', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0', 'other-plugin'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({}, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    const tuiContent = JSON.parse(fs.readFileSync(tuiPath));
    expect(opencodeContent.plugins).toEqual(['other-plugin']);
    expect(tuiContent.plugins).toEqual([]);
  });

  it('uninstall when not installed is no-op (status=skipped)', () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
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
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [cfgDir]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({ dryRun: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    const opencodeContent = JSON.parse(fs.readFileSync(opencodePath));
    expect(opencodeContent.plugins).toContain('opencode-rules-md@1.0.0');
  });

  it('--purge deletes cache only, not rule dirs', () => {
    const home = homedir();
    const cacheDir = resolve(home, '.cache', 'opencode', 'node_modules', 'opencode-rules-md');
    const ruleDir = resolve(home, '.local', 'share', 'opencode-rules-md');
    const opencodePath = resolve(home, '.config', 'opencode', 'opencode.json');
    const tuiPath = resolve(home, '.config', 'opencode', 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [resolve(cacheDir, 'package.json')]: '{}',
      [resolve(ruleDir, 'rules.md')]: '# Rules',
    }, [
      resolve(home, '.cache', 'opencode', 'node_modules'),
      cacheDir,
      resolve(home, '.local', 'share'),
      ruleDir,
    ]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({ purge: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    expect(result.purged).toBe(true);
    // Cache node_modules should be gone
    expect(fs.existsSync(cacheDir)).toBe(false);
    // Rule dir should still exist
    expect(fs.existsSync(ruleDir)).toBe(true);
  });

  it('--purge with no cache dir is silent success', () => {
    const home = homedir();
    const opencodePath = resolve(home, '.config', 'opencode', 'opencode.json');
    const tuiPath = resolve(home, '.config', 'opencode', 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@1.0.0'] }),
    }, [resolve(home, '.config', 'opencode')]);
    const fakeEnv = makeFakeEnv();

    const result = runUninstall({ purge: true }, fs, fakeEnv);

    expect(result.status).toBe('wrote');
    expect(result.purged).toBe(false);
  });
});
