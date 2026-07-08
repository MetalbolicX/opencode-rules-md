// tests/tui-dist.test.ts
/**
 * Regression test: bundled TUI module loads and registers sidebar_content slot.
 *
 * Strict TDD:
 * - Phase 1 (RED): slot registration + no-throw import
 * - Phase 2 (GREEN): lifecycle.onDispose cleanup
 *
 * Tests verify the bundled dist/tui.js (not raw tui/index.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock host API shape that the bundled tui.js expects
function createMockApi() {
  let disposeFn: (() => void) | null = null;
  const registeredSlots: Map<string, unknown> = new Map();

  return {
    slots: {
      register: vi.fn((plugin: {
        order?: number;
        slots: Record<string, (ctx: unknown, props: unknown) => unknown>;
      }) => {
        const slotKey = Object.keys(plugin.slots)[0];
        registeredSlots.set(slotKey, plugin.slots[slotKey]);
        return slotKey;
      }),
    },
    lifecycle: {
      onDispose: vi.fn((cb: () => void) => {
        disposeFn = cb;
      }),
    },
    event: {
      on: vi.fn(() => vi.fn()),
    },
    state: {
      path: {
        state: '/mock/.opencode/state',
        config: '/mock/.opencode/config',
        worktree: '/mock/.opencode/worktree',
        directory: '/mock/project',
      },
    },
    workspace: {
      get: vi.fn(() => ({ directory: '/mock/project' })),
    },
    _getDisposeFn: () => disposeFn,
    _getRegisteredSlots: () => registeredSlots,
  };
}

describe('bundled tui.js', () => {
  let mockApi: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    mockApi = createMockApi();
    vi.clearAllMocks();
  });

  // ── Phase 1 RED: slot registration ─────────────────────────────────────────

  it('imports dist/tui.js without throwing', async () => {
    // Fails until build pipeline produces dist/tui.js
    const tui = await import('../dist/tui.js');
    expect(tui).toBeDefined();
  });

  it('default export registers sidebar_content slot without throwing', async () => {
    const tui = await import('../dist/tui.js');
    expect(tui.default).toBeDefined();
    expect(typeof tui.default.tui).toBe('function');

    // Slot registration must not throw
    await expect(tui.default.tui(mockApi as never)).resolves.not.toThrow();
    expect(mockApi.slots.register).toHaveBeenCalledTimes(1);
    const registeredSlots = mockApi._getRegisteredSlots();
    expect(registeredSlots.has('sidebar_content')).toBe(true);
  });

  // ── Phase 2 GREEN: lifecycle cleanup (implements createRoot + onDispose) ───────

  it('registers a dispose callback via api.lifecycle.onDispose', async () => {
    const tui = await import('../dist/tui.js');
    await tui.default.tui(mockApi as never);

    expect(mockApi.lifecycle.onDispose).toHaveBeenCalledTimes(1);
    const disposeFn = mockApi._getDisposeFn();
    expect(typeof disposeFn).toBe('function');
    expect(() => disposeFn!()).not.toThrow();
  });
});
