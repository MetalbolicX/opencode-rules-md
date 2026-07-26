import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queryAvailableToolIDs,
  type ToolQueryClient,
} from './tool-query-service.js';

function silentDebugLog(): void {
  /* no-op */
}

function makeToolClient(
  fn: (args: { query: { directory: string } }) => Promise<{ data?: string[] }>
): ToolQueryClient {
  return { tool: { ids: fn } };
}

function makeMcpClient(
  fn: (args: { query: { directory: string } }) => Promise<{ data?: unknown }>
): ToolQueryClient {
  return { mcp: { status: fn } };
}

describe('queryAvailableToolIDs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns combined, deduped IDs when both tool and mcp queries succeed', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => ({ data: ['bash', 'read', 'edit'] }) },
      mcp: {
        status: async () => ({
          data: {
            context7: { status: 'connected' },
            sequential: { status: 'connected' },
          },
        }),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids.sort()).toEqual(
      ['bash', 'edit', 'mcp_context7', 'mcp_sequential', 'read'].sort()
    );
  });

  it('returns only tool IDs when only tool query succeeds', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => ({ data: ['bash', 'read'] }) },
      mcp: {
        status: async () => ({
          data: {
            context7: { status: 'failed' },
          },
        }),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids.sort()).toEqual(['bash', 'read']);
  });

  it('returns only mcp capability IDs when only mcp query succeeds', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => ({ data: [] }) },
      mcp: {
        status: async () => ({
          data: {
            context7: { status: 'connected' },
            disabled: { status: 'disconnected' },
          },
        }),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['mcp_context7']);
  });

  it('returns mcp IDs and warns when tool query rejects', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => Promise.reject(new Error('tool boom')) },
      mcp: {
        status: async () => ({
          data: { context7: { status: 'connected' } },
        }),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['mcp_context7']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, ...rest] = warnSpy.mock.calls[0];
    expect(message).toContain('Failed to query tool IDs');
    expect(message).toContain('tool boom');
    expect(rest).toHaveLength(0);
  });

  it('returns tool IDs and warns when mcp query rejects', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => ({ data: ['bash'] }) },
      mcp: {
        status: async () => Promise.reject(new Error('mcp boom')),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['bash']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Failed to query MCP status');
    expect(warnSpy.mock.calls[0][0]).toContain('mcp boom');
  });

  it('returns empty array and warns twice when both queries reject', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => Promise.reject(new Error('tool down')) },
      mcp: { status: async () => Promise.reject(new Error('mcp down')) },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const allMessages = warnSpy.mock.calls.map(call => String(call[0]));
    expect(allMessages.some(m => m.includes('Failed to query tool IDs'))).toBe(
      true
    );
    expect(
      allMessages.some(m => m.includes('Failed to query MCP status'))
    ).toBe(true);
  });

  it('returns empty array and no warnings when neither method exists', async () => {
    const client: ToolQueryClient = {};

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when both data payloads are empty', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ignores tool data that is not an array', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => ({ data: 'nope' as unknown as string[] }) },
      mcp: {
        status: async () => ({ data: { context7: { status: 'connected' } } }),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['mcp_context7']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('coerces non-Error rejection values to strings in the warning', async () => {
    const client: ToolQueryClient = {
      tool: { ids: async () => Promise.reject('string failure') },
      mcp: {
        status: async () => ({ data: { context7: { status: 'connected' } } }),
      },
    };

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['mcp_context7']);
    expect(warnSpy.mock.calls[0][0]).toContain('string failure');
  });

  it('passes the directory to query args', async () => {
    const toolIdsFn = vi.fn(async () => ({ data: ['bash'] }));
    const mcpStatusFn = vi.fn(async () => ({ data: {} }));
    const client: ToolQueryClient = {
      tool: { ids: toolIdsFn },
      mcp: { status: mcpStatusFn },
    };

    await queryAvailableToolIDs(client, '/some/dir', silentDebugLog);

    expect(toolIdsFn).toHaveBeenCalledWith({
      query: { directory: '/some/dir' },
    });
    expect(mcpStatusFn).toHaveBeenCalledWith({
      query: { directory: '/some/dir' },
    });
  });

  it('is callable with the helper factory functions for tool-only clients', async () => {
    const client = makeToolClient(async () => ({ data: ['bash'] }));

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['bash']);
  });

  it('is callable with the helper factory functions for mcp-only clients', async () => {
    const client = makeMcpClient(async () => ({
      data: { context7: { status: 'connected' } },
    }));

    const ids = await queryAvailableToolIDs(client, '/tmp', silentDebugLog);

    expect(ids).toEqual(['mcp_context7']);
  });
});
