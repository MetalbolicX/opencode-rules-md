import { extractConnectedMcpCapabilityIDs } from './mcp-tools.js';
import { logWarning } from './log.js';
import type { DebugLog } from './debug.js';

/**
 * Narrow surface of the OpenCode SDK client that {@link queryAvailableToolIDs}
 * actually depends on. Keeps the call site typed without `unknown`/`any`
 * escape hatches and lets tests inject a fake client.
 */
export interface ToolQueryClient {
  tool?: {
    ids?: (args: { query: { directory: string } }) => Promise<{
      data?: string[];
    }>;
  };
  mcp?: {
    status?: (args: { query: { directory: string } }) => Promise<{
      data?: unknown;
    }>;
  };
}

/**
 * Query the OpenCode SDK for the set of tool IDs available in the given
 * directory, combining built-in tools and connected MCP capability IDs.
 *
 * Both RPCs are best-effort: a rejection from either is logged via
 * {@link logWarning} and the IDs from the other side are still returned.
 *
 * @param client - OpenCode SDK client (or a structural subset — see
 *   {@link ToolQueryClient})
 * @param directory - Project directory passed to the SDK's `query` argument
 * @param debugLog - Debug log sink (no-op by default)
 * @returns Deduplicated list of tool IDs in arbitrary order
 */
export async function queryAvailableToolIDs(
  client: ToolQueryClient,
  directory: string,
  debugLog: DebugLog
): Promise<string[]> {
  const ids = new Set<string>();
  const query = { directory };

  const [toolResult, mcpResult] = await Promise.allSettled([
    client.tool?.ids?.({ query }),
    client.mcp?.status?.({ query }),
  ]);

  if (
    toolResult.status === 'fulfilled' &&
    Array.isArray(toolResult.value?.data)
  ) {
    const toolIds = toolResult.value.data;
    for (const id of toolIds) {
      ids.add(id);
    }
    debugLog(
      `Built-in tools: ${toolIds.slice(0, 10).join(', ')}${toolIds.length > 10 ? '...' : ''} (${toolIds.length} total)`
    );
  } else if (toolResult.status === 'rejected') {
    logWarning('Failed to query tool IDs', toolResult.reason);
  }

  if (mcpResult.status === 'fulfilled' && mcpResult.value?.data) {
    const mcpIds = extractConnectedMcpCapabilityIDs(
      mcpResult.value.data as Parameters<
        typeof extractConnectedMcpCapabilityIDs
      >[0]
    );
    for (const id of mcpIds) {
      ids.add(id);
    }
    if (mcpIds.length > 0) {
      debugLog(`MCP capability IDs: ${mcpIds.join(', ')}`);
    }
  } else if (mcpResult.status === 'rejected') {
    logWarning('Failed to query MCP status', mcpResult.reason);
  }

  return Array.from(ids);
}
