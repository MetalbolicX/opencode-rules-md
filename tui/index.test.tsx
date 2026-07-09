// tui/index.test.tsx
import { describe, it, expect, vi } from 'vitest';
import pluginExports from './index.js';

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
