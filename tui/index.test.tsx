// tui/index.test.tsx
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pluginExports from './index.js';

// ESM __dirname equivalent — works even through vitest's transform layer.
const __testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__testDir, '..');

// ──────────────────────────────────────────────
// Bundle smoke regression — verifies the built
// dist/tui/index.js artifact exposes the TUI
// plugin contract (default.tui + sidebar_content).
// Fails BEFORE `bun run build` creates the bundle,
// and passes AFTER scripts/build-tui.mjs emits it.
// ──────────────────────────────────────────────
describe('TUI bundle smoke', () => {
  // Use import.meta.url of the TEST FILE to resolve the path to the built bundle.
  // The test file is at tui/index.test.tsx, so '../dist/tui/index.js' resolves to
  // the project-root-relative dist/ directory correctly regardless of cwd.
  // Vitest transforms import() calls through its own resolver, so we need
  // an absolute path that survives the transform.
  const distPath = resolve(projectRoot, 'dist/tui/index.js');

  beforeAll(async () => {
    const { statSync } = await import('fs');
    // Fail fast with a clear message if the bundle hasn't been built yet.
    try {
      statSync(distPath);
    } catch {
      throw new Error(
        `[BUNDLE SMOKE] dist/tui/index.js not found.\n` +
          `Run "bun run build" to produce the bundle before running tests.`
      );
    }
  });

  it('bundle exports default.tui function', async () => {
    // Use file:// URL with the absolute path so vitest's resolver cannot misresolve it.
    const bundle = await import(`file://${distPath}`);
    expect(bundle.default).toBeDefined();
    expect(typeof bundle.default.tui).toBe('function');
  });

  it('bundle.tui registers sidebar_content slot', async () => {
    const { default: plugin } = await import(`file://${distPath}`);
    const mockRegister = vi.fn(() => 'ok');
    const mockApi = {
      slots: { register: mockRegister },
      lifecycle: { onDispose: vi.fn() },
      workspace: { get: vi.fn(), current: vi.fn(), set: vi.fn() },
      state: {
        path: {
          state: '/tmp/s',
          config: '/tmp/c',
          worktree: '/tmp/w',
          directory: '/tmp',
        },
        workspace: { get: vi.fn() },
      },
      kv: new Map(),
      event: { on: vi.fn(() => () => {}) },
    } as any;
    await plugin.tui(mockApi as any);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    const registered = mockRegister.mock.calls[0]![0];
    expect(registered.slots).toBeDefined();
    expect(typeof registered.slots.sidebar_content).toBe('function');
  });
});

describe('TUI plugin entry point', () => {
  it('exports a default object with id and tui', () => {
    expect(pluginExports).toBeDefined();
    expect(typeof pluginExports).toBe('object');
  });

  it('exports id equal to "opencode-rules-md"', () => {
    expect(pluginExports.id).toBe('opencode-rules-md');
  });

  it('exports tui as a function', () => {
    expect(typeof pluginExports.tui).toBe('function');
  });

  it('tui registers sidebar_content slot when called', async () => {
    const mockDispose = vi.fn();
    const mockRegister = vi.fn(() => 'ok');

    const mockApi = {
      slots: {
        register: mockRegister,
      },
      lifecycle: {
        onDispose: mockDispose,
      },
      workspace: {
        get: vi.fn(() => undefined),
        current: vi.fn(() => undefined),
        set: vi.fn(),
      },
      state: {
        path: {
          state: '/tmp/opencode/state',
          config: '/tmp/opencode/config',
          worktree: '/tmp/opencode/worktree',
          directory: '/tmp',
        },
        workspace: {
          get: vi.fn(() => ({ directory: '/tmp' })),
        },
      },
      kv: new Map(),
      event: {
        on: vi.fn(() => () => {}),
      },
    } as any;

    await pluginExports.tui(mockApi as any);

    expect(mockRegister).toHaveBeenCalledTimes(1);
    const registeredPlugin = mockRegister.mock.calls[0]![0];
    expect(registeredPlugin.slots).toBeDefined();
    expect(typeof registeredPlugin.slots.sidebar_content).toBe('function');
  });

  it('tui registers sidebar_content with order 350', async () => {
    const mockRegister = vi.fn(() => 'ok');

    const mockApi = {
      slots: { register: mockRegister },
      lifecycle: { onDispose: vi.fn() },
      workspace: { get: vi.fn(), current: vi.fn(), set: vi.fn() },
      state: {
        path: {
          state: '/tmp/s',
          config: '/tmp/c',
          worktree: '/tmp/w',
          directory: '/tmp',
        },
        workspace: { get: vi.fn() },
      },
      kv: new Map(),
      event: { on: vi.fn(() => () => {}) },
    } as any;

    await pluginExports.tui(mockApi as any);

    const registeredPlugin = mockRegister.mock.calls[0]![0];
    expect(registeredPlugin.order).toBe(350);
  });

  it('tui does not throw when called', async () => {
    const mockApi = {
      slots: { register: vi.fn(() => 'ok') },
      lifecycle: { onDispose: vi.fn() },
      workspace: { get: vi.fn(), current: vi.fn(), set: vi.fn() },
      state: {
        path: {
          state: '/tmp/s',
          config: '/tmp/c',
          worktree: '/tmp/w',
          directory: '/tmp',
        },
        workspace: { get: vi.fn() },
      },
      kv: new Map(),
      event: { on: vi.fn(() => () => {}) },
    } as any;

    await expect(pluginExports.tui(mockApi as any)).resolves.toBeUndefined();
  });
});
