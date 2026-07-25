/**
 * Rule filtering and matching utilities
 */

import { minimatch } from 'minimatch';
import { createDebugLog } from './debug.js';
import { getCachedRule, type DiscoveredRule } from './rule-discovery.js';
import type { RuleMetadata } from './rule-metadata.js';

const debugLog = createDebugLog();

/** Header preamble prepended to the formatted rule block. */
const RULES_HEADER =
  '# OpenCode Rules\n\nPlease follow the following rules:\n\n';

/** Separator inserted between formatted rule entries. */
const RULE_SEPARATOR = '\n\n---\n\n';

/**
 * Check if a file path matches any of the given glob patterns
 */
function fileMatchesGlobs(filePath: string, globs: string[]): boolean {
  return globs.some(glob => minimatch(filePath, glob, { matchBase: true }));
}

/**
 * Check if a user prompt matches any of the given keywords.
 * Uses case-insensitive word-boundary matching.
 *
 * @param prompt - The user's prompt text
 * @param keywords - Array of keywords to match
 * @returns true if any keyword matches the prompt
 */
export function promptMatchesKeywords(
  prompt: string,
  keywords: string[]
): boolean {
  const lowerPrompt = prompt.toLowerCase();

  return keywords.some(keyword => {
    const lowerKeyword = keyword.toLowerCase();
    // Escape special regex characters in the keyword
    const escaped = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word boundary at start, but allow continuation at end (e.g., "test" matches "testing")
    const regex = new RegExp(`\\b${escaped}`, 'i');
    return regex.test(lowerPrompt);
  });
}

/**
 * Check if any of the required tools are available.
 * Uses exact string matching (OR logic: any match returns true).
 *
 * @param availableToolIDs - Array of tool IDs currently available
 * @param requiredTools - Array of tool IDs from rule metadata
 * @returns true if any required tool is available
 */
export function toolsMatchAvailable(
  availableToolIDs: string[],
  requiredTools: string[]
): boolean {
  if (requiredTools.length === 0) {
    return false;
  }
  // Create a Set for O(1) lookups
  const availableSet = new Set(availableToolIDs);
  return requiredTools.some(tool => availableSet.has(tool));
}

/**
 * Rough token estimate using the chars/4 heuristic.
 * No external dependency; accurate enough for budget decisions.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Result of reading and formatting rules
 */
export interface FilterResult {
  formattedRules: string;
  matchedPaths: string[];
  /** Estimated token count of formattedRules (0 when empty) */
  tokenEstimate: number;
}

/**
 * Runtime filter context for conditional rule matching
 */
export interface RuleFilterContext {
  /** File paths from conversation context (for glob matching) */
  contextFilePaths?: string[];
  /** User's prompt text (for keyword matching) */
  userPrompt?: string;
  /** Available tool IDs (for tool-based filtering) */
  availableToolIDs?: string[];
  /** Current model ID */
  modelID?: string;
  /** Current agent type */
  agentType?: string;
  /** Current slash command (e.g., /plan, /review) */
  command?: string;
  /** Detected project tags (e.g., node, python, monorepo) */
  projectTags?: string[];
  /** Current git branch name */
  gitBranch?: string;
  /** Current operating system (e.g., linux, darwin, win32) */
  os?: string;
  /** Whether running in CI environment */
  ci?: boolean;
  /** Optional hard token cap; lowest-priority rules are dropped when exceeded. */
  maxTokens?: number;
}

/**
 * A rule that has cleared conditional filtering and is awaiting dedup/budget
 * selection. Fields are pre-computed so dedup and budget helpers stay pure.
 */
export interface MatchedEntry {
  filePath: string;
  relativePath: string;
  strippedContent: string;
  priority: number;
  tokenCount: number;
  /** Monotonically increasing discovery index; lower = discovered earlier. */
  index: number;
}

/**
 * Evaluate a rule's conditional metadata against the runtime filter context.
 *
 * Returns true when the rule should be included (no conditions declared, or
 * the declared-condition checks pass under the `match` combinator). Returns
 * false when at least one declared check fails the combinator. Undeclared
 * dimensions are skipped (vacuously true) rather than failed.
 */
export function matchRuleConditions(
  metadata: RuleMetadata | undefined | null,
  ctx: RuleFilterContext,
  availableToolSet: Set<string> | undefined,
  relativePathForLog: string
): boolean {
  if (!metadata) return true;

  const hasConditions = Boolean(
    metadata.globs ||
    metadata.keywords ||
    metadata.tools ||
    metadata.model ||
    metadata.agent ||
    metadata.command ||
    metadata.project ||
    metadata.branch ||
    metadata.os ||
    metadata.ci !== undefined
  );

  if (!hasConditions) return true;

  const declaredChecks: boolean[] = [];

  if (metadata.globs) {
    const globs: string[] = metadata.globs;
    const globsMatch =
      ctx.contextFilePaths &&
      ctx.contextFilePaths.length > 0 &&
      ctx.contextFilePaths.some(contextPath =>
        fileMatchesGlobs(contextPath, globs)
      );
    declaredChecks.push(Boolean(globsMatch));
  }

  if (metadata.keywords) {
    const keywordsMatch =
      ctx.userPrompt &&
      promptMatchesKeywords(ctx.userPrompt, metadata.keywords);
    declaredChecks.push(Boolean(keywordsMatch));
  }

  if (metadata.tools) {
    const tools: string[] = metadata.tools;
    const toolsMatch =
      availableToolSet &&
      tools.some((tool: string) => availableToolSet.has(tool));
    declaredChecks.push(Boolean(toolsMatch));
  }

  if (metadata.model) {
    const modelMatch = ctx.modelID && metadata.model.includes(ctx.modelID);
    declaredChecks.push(Boolean(modelMatch));
  }

  if (metadata.agent) {
    const agentMatch = ctx.agentType && metadata.agent.includes(ctx.agentType);
    declaredChecks.push(Boolean(agentMatch));
  }

  if (metadata.command) {
    const commandMatch = ctx.command && metadata.command.includes(ctx.command);
    declaredChecks.push(Boolean(commandMatch));
  }

  if (metadata.project) {
    const projectTags = ctx.projectTags;
    const projectMatch =
      projectTags &&
      projectTags.length > 0 &&
      metadata.project.some((tag: string) => projectTags.includes(tag));
    declaredChecks.push(Boolean(projectMatch));
  }

  if (metadata.branch) {
    const gitBranch = ctx.gitBranch;
    const branchMatch =
      gitBranch &&
      metadata.branch.some((pattern: string) => {
        if (pattern === gitBranch) return true;
        const hasGlobChars = /[*?\[{]/.test(pattern);
        return hasGlobChars ? minimatch(gitBranch, pattern) : false;
      });
    declaredChecks.push(Boolean(branchMatch));
  }

  if (metadata.os) {
    const osMatch = ctx.os && metadata.os.includes(ctx.os);
    declaredChecks.push(Boolean(osMatch));
  }

  if (metadata.ci !== undefined) {
    declaredChecks.push(ctx.ci === metadata.ci);
  }

  const mode = metadata.match ?? 'any';
  const shouldInclude =
    mode === 'all'
      ? declaredChecks.every(Boolean)
      : declaredChecks.some(Boolean);

  if (!shouldInclude) {
    debugLog(
      `Skipping conditional rule: ${relativePathForLog} (match: ${mode}, checks: ${declaredChecks.join(', ')})`
    );
  } else {
    debugLog(
      `Including conditional rule: ${relativePathForLog} (match: ${mode}, checks: ${declaredChecks.join(', ')})`
    );
  }

  return shouldInclude;
}

/**
 * Read and format rule files for system prompt injection
 * @param files - Array of discovered rule files with paths
 * @param context - Optional RuleFilterContext for conditional rule matching
 */
export async function readAndFormatRules(
  files: DiscoveredRule[],
  context: RuleFilterContext = {}
): Promise<FilterResult> {
  if (files.length === 0) {
    return { formattedRules: '', matchedPaths: [], tokenEstimate: 0 };
  }

  const availableToolSet =
    context.availableToolIDs && context.availableToolIDs.length > 0
      ? new Set(context.availableToolIDs)
      : undefined;

  // Collect matched entries with priority and token count
  const entries: MatchedEntry[] = [];
  let entryIndex = 0;

  for (const { filePath, relativePath } of files) {
    // Use cached rule data with mtime-based invalidation
    const cachedRule = await getCachedRule(filePath);
    if (!cachedRule) {
      continue; // Error already logged by getCachedRule
    }

    const { metadata, strippedContent } = cachedRule;

    if (
      !matchRuleConditions(metadata, context, availableToolSet, relativePath)
    ) {
      continue;
    }

    // Extract priority (default 0 for selection; undefined in metadata means absent)
    const priority = metadata?.priority ?? 0;

    // Build formatted chunk for token counting
    const formattedChunk = `## ${relativePath}\n\n${strippedContent}`;
    const tokenCount = estimateTokens(formattedChunk);

    entries.push({
      filePath,
      relativePath,
      strippedContent,
      priority,
      tokenCount,
      index: entryIndex++,
    });
  }

  if (entries.length === 0) {
    return { formattedRules: '', matchedPaths: [], tokenEstimate: 0 };
  }

  const deduplicatedEntries = deduplicateEntries(entries);
  const survivors = selectByTokenBudget(deduplicatedEntries, context.maxTokens);
  return formatRules(survivors);
}

/**
 * Collapse entries that share identical `strippedContent`. For each content key,
 * the entry with the higher `priority` wins; on equal priority, the entry with
 * the higher `index` (later-discovered) wins. Result is sorted by index
 * ascending so downstream stages see discovery order.
 */
export function deduplicateEntries(entries: MatchedEntry[]): MatchedEntry[] {
  const dedupedMap = new Map<string, MatchedEntry>();
  for (const entry of entries) {
    const existing = dedupedMap.get(entry.strippedContent);
    if (!existing) {
      dedupedMap.set(entry.strippedContent, entry);
    } else {
      const replace =
        entry.priority > existing.priority ||
        (entry.priority === existing.priority && entry.index > existing.index);
      if (replace) {
        debugLog(
          `Deduplicating rule content: ${existing.relativePath} -> ${entry.relativePath} (shared content)`
        );
        dedupedMap.set(entry.strippedContent, entry);
      } else {
        debugLog(
          `Deduplicating rule content: ${entry.relativePath} -> ${existing.relativePath} (shared content)`
        );
      }
    }
  }
  return [...dedupedMap.values()].sort((a, b) => a.index - b.index);
}

/**
 * Greedy token-budget selection over deduplicated entries.
 *
 * - When `maxTokens` is not a finite positive number (undefined, 0, negative,
 *   NaN, Infinity), entries are returned in discovery order with no filtering.
 * - Otherwise entries are stably sorted by priority desc, index asc; the first
 *   sorted entry is always kept (≥1 survivor invariant), and remaining entries
 *   are appended greedily while their cumulative token cost stays ≤ `maxTokens`.
 */
export function selectByTokenBudget(
  entries: MatchedEntry[],
  maxTokens: number | undefined
): MatchedEntry[] {
  const hasValidBudget =
    typeof maxTokens === 'number' &&
    maxTokens > 0 &&
    Number.isFinite(maxTokens);

  if (!hasValidBudget) {
    return entries;
  }

  const sorted = [...entries].sort(
    (a, b) => b.priority - a.priority || a.index - b.index
  );
  const survivors: MatchedEntry[] = [sorted[0]];
  let runningTokens = sorted[0].tokenCount;
  for (let i = 1; i < sorted.length; i++) {
    if (runningTokens + sorted[i].tokenCount <= maxTokens) {
      survivors.push(sorted[i]);
      runningTokens += sorted[i].tokenCount;
    }
  }
  return survivors;
}

/**
 * Build the final formatted block: preamble + per-rule `## path\n\nbody`
 * chunks joined by `RULE_SEPARATOR`. `tokenEstimate` reflects the entire
 * formatted output, not just the bodies.
 */
export function formatRules(survivors: MatchedEntry[]): FilterResult {
  const ruleContents = survivors.map(
    entry => `## ${entry.relativePath}\n\n${entry.strippedContent}`
  );
  const matchedPaths = survivors.map(entry => entry.filePath);
  const formattedRules = RULES_HEADER + ruleContents.join(RULE_SEPARATOR);
  return {
    formattedRules,
    matchedPaths,
    tokenEstimate: estimateTokens(formattedRules),
  };
}
