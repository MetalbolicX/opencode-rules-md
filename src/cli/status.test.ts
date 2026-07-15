/**
 * src/cli/status.test.ts
 *
 * TDD RED tests for CLI status and doctor commands.
 * - status: read-only probe for both configs (path, format, specifier,
 *   other plugins, installed vs latest version, not-installed message)
 * - doctor: health checks grouped into issues/warnings/info; exit 1 on issues
 *
 * RED state: run `bun run test:run src/cli/status.test.ts` — tests fail because
 * src/cli/status.ts does not exist yet.
 * GREEN state: all tests pass once status.ts is implemented.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';

// ─── Direct imports — fail at load time in RED until modules exist ───────────

// @ts-ignore — module not yet written
import { runStatus, runDoctor } from '../cli/status.js';
// @ts-ignore — types not yet written
import type { StatusResult, DoctorResult } from '../cli/status.js';

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

// Helper: cast result.configs to StatusResult['configs'] to avoid TS inference issues in RED
type ConfigEntry = { basename: string; path: string; format: string; installed: string | null; notInstalled?: boolean; otherPlugins: string[] };

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: runStatus — read-only status probe
// ═══════════════════════════════════════════════════════════════════════════════

describe('runStatus', () => {
  it('returns structured StatusResult for both configs', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0', 'other-plugin'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const result = await runStatus(
      fs,
      fakeEnv,
      (s: string) => { console_.logs.push(s); },
    ) as StatusResult;

    // Should return a structured result with entries for both configs
    expect(result.configs).toBeDefined();
    expect(Array.isArray(result.configs)).toBe(true);
    expect(result.configs.length).toBeGreaterThanOrEqual(2);
  });

  it('reports path for each config', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const logFn = (s: string) => { console_.logs.push(s); };
    const result = await runStatus(fs, fakeEnv, logFn) as StatusResult;

    const configs = result.configs as ConfigEntry[];
    const opencodeEntry = configs.find(e => e.basename === 'opencode');
    const tuiEntry = configs.find(e => e.basename === 'tui');

    expect(opencodeEntry?.path).toBe(opencodePath);
    expect(tuiEntry?.path).toBe(tuiPath);
  });

  it('reports format (.json or .jsonc) for each config', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.jsonc');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const logFn = (s: string) => { console_.logs.push(s); };
    const result = await runStatus(fs, fakeEnv, logFn) as StatusResult;

    const configs = result.configs as ConfigEntry[];
    const opencodeEntry = configs.find(e => e.basename === 'opencode');
    const tuiEntry = configs.find(e => e.basename === 'tui');

    expect(opencodeEntry?.format).toBe('.json');
    expect(tuiEntry?.format).toBe('.jsonc');
  });

  it('reports installed specifier when plugin is present', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const logFn = (s: string) => { console_.logs.push(s); };
    const result = await runStatus(fs, fakeEnv, logFn) as StatusResult;

    const configs = result.configs as ConfigEntry[];
    const opencodeEntry = configs.find(e => e.basename === 'opencode');
    expect(opencodeEntry?.installed).toBe('opencode-rules-md@2.0.0');
  });

  it('reports not-installed when plugin absent', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const logFn = (s: string) => { console_.logs.push(s); };
    const result = await runStatus(fs, fakeEnv, logFn) as StatusResult;

    const configs = result.configs as ConfigEntry[];
    const opencodeEntry = configs.find(e => e.basename === 'opencode');
    expect(opencodeEntry?.installed).toBeNull();
    expect(opencodeEntry?.notInstalled).toBe(true);
  });

  it('reports other plugins alongside the specifier', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0', 'other-plugin', 'another-one'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    const logFn = (s: string) => { console_.logs.push(s); };
    const result = await runStatus(fs, fakeEnv, logFn) as StatusResult;

    const configs = result.configs as ConfigEntry[];
    const tuiEntry = configs.find(e => e.basename === 'tui');
    expect(tuiEntry?.otherPlugins).toContain('other-plugin');
    expect(tuiEntry?.otherPlugins).toContain('another-one');
  });

  it('is read-only: does not modify any files', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    // Capture file map keys before
    const beforeKeys = [...fs.readdirSync(cfgDir)];

    await runStatus(fs, fakeEnv, (s: string) => { console_.logs.push(s); });

    const afterKeys = [...fs.readdirSync(cfgDir)];
    // No files added or removed
    expect(afterKeys.sort()).toEqual(beforeKeys.sort());

    // Content unchanged
    const content = fs.readFileSync(opencodePath);
    expect(JSON.parse(content)).toEqual({ plugins: ['opencode-rules-md@2.0.0'] });
  });

  it('prints status lines to the provided log function', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv();
    const console_ = makeConsole();

    await runStatus(fs, fakeEnv, (s: string) => { console_.logs.push(s); });

    // Should have produced some console output
    expect(console_.logs.length).toBeGreaterThan(0);
    const output = console_.logs.join(' ');
    // At least one line should mention opencode-rules-md
    expect(output).toContain('opencode-rules-md');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests: runDoctor — health checks
// ═══════════════════════════════════════════════════════════════════════════════

describe('runDoctor', () => {
  it('returns DoctorResult with ok=true when all checks pass', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const parentDir = resolve(home, '.config');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir, parentDir]);

    const fakeEnv = makeFakeEnv({ HOME: home });
    const console_ = makeConsole();

    // Override node and bun detection for a clean bill of health
    const result = await runDoctor(fs, fakeEnv, (s: string) => { console_.logs.push(s); }, (s: string) => { console_.errors.push(s); }, {
      nodeVersion: '20.0.0',
      hasBun: true,
    }) as DoctorResult;

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('returns ok=false and issues when Node < 20', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv({ HOME: home });
    const console_ = makeConsole();

    const result = await runDoctor(fs, fakeEnv, (s: string) => { console_.logs.push(s); }, (s: string) => { console_.errors.push(s); }, {
      nodeVersion: '18.0.0',
      hasBun: true,
    }) as DoctorResult;

    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((i: string) => i.toLowerCase().includes('node'))).toBe(true);
  });

  it('returns ok=false and issues when Bun is not on PATH', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv({ HOME: home });
    const console_ = makeConsole();

    const result = await runDoctor(fs, fakeEnv, (s: string) => { console_.logs.push(s); }, (s: string) => { console_.errors.push(s); }, {
      nodeVersion: '20.0.0',
      hasBun: false,
    }) as DoctorResult;

    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('warns (not issues) when rule dir does not exist', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const parentDir = resolve(home, '.config');
    const opencodePath = resolve(cfgDir, 'opencode.json');
    const tuiPath = resolve(cfgDir, 'tui.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
      [tuiPath]: JSON.stringify({ plugins: ['opencode-rules-md@2.0.0'] }),
    }, [cfgDir, parentDir]);

    const fakeEnv = makeFakeEnv({ HOME: home });
    const console_ = makeConsole();

    const result = await runDoctor(fs, fakeEnv, (s: string) => { console_.logs.push(s); }, (s: string) => { console_.errors.push(s); }, {
      nodeVersion: '20.0.0',
      hasBun: true,
      ruleDirExists: false,
    }) as DoctorResult;

    // Rule dir is a warning, not a blocking issue
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
  });

  it('reports issues, warnings, and info grouped in the result', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv({ HOME: home });
    const console_ = makeConsole();

    const result = await runDoctor(fs, fakeEnv, (s: string) => { console_.logs.push(s); }, (s: string) => { console_.errors.push(s); }, {
      nodeVersion: '18.0.0',
      hasBun: false,
    }) as DoctorResult;

    expect(result.issues).toBeDefined();
    expect(result.warnings).toBeDefined();
    expect(result.info).toBeDefined();
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.info)).toBe(true);
  });

  it('prints doctor output to the provided log/error functions', async () => {
    const home = homedir();
    const cfgDir = resolve(home, '.config', 'opencode');
    const opencodePath = resolve(cfgDir, 'opencode.json');

    const fs = makeFakeFs({
      [opencodePath]: JSON.stringify({ plugins: [] }),
    }, [cfgDir]);

    const fakeEnv = makeFakeEnv({ HOME: home });
    const console_ = makeConsole();

    await runDoctor(fs, fakeEnv, (s: string) => { console_.logs.push(s); }, (s: string) => { console_.errors.push(s); }, {
      nodeVersion: '20.0.0',
      hasBun: true,
    });

    // Should have produced some output
    expect(console_.logs.length + console_.errors.length).toBeGreaterThan(0);
  });
});
