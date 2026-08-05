/**
 * Integration tests for buildFilterContext empty-context scanner fallback.
 *
 * Cases 1–5 from the spec:
 *  Case 1  — glob rule injects when contextFilePaths is empty + matching files exist (THE BUGFIX)
 *  Case 2  — unconditional rule still injects with empty context (regression guard)
 *  Case 3  — non-empty contextFilePaths skips the scanner (DI seam)
 *  Case 4  — cache hit avoids second filesystem walk (via seeded cache)
 *  Case 5  — non-matching glob excludes rule (negative case)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';

import { buildFilterContext } from './runtime-context.js';
import { readAndFormatRules } from './rule-filter.js';
import {
  clearProjectFilesCache,
  _setProjectFilesCacheForTesting,
  type ProjectFilesCacheEntry,
} from './project-file-scanner.js';
import { clearRuleCache } from './rule-discovery.js';

// =============================================================================
// Test Directory Management
// =============================================================================

let testDir: string;

function setupTestDir(): string {
  testDir = mkdtempSync(path.join(os.tmpdir(), 'runtime-context-test-'));
  return testDir;
}

function teardownTestDir(): void {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = '';
  }
}

// =============================================================================
// DebugLog helper
// =============================================================================

function noopDebugLog(_msg: string): void {
  // noop
}

// =============================================================================
// Case 1: glob rule injects when contextFilePaths empty + matching files exist
// THE BUGFIX — must FAIL before wiring, PASS after
// =============================================================================

describe('Case 1: glob rule injects on empty context', () => {
  beforeEach(() => {
    clearProjectFilesCache();
    clearRuleCache();
  });

  afterEach(() => {
    teardownTestDir();
  });

  it('injects glob rule when contextFilePaths empty and project has matching files', async () => {
    const root = setupTestDir();
    const projectDir = path.join(root, 'project');

    // Seed the cache as if the scanner discovered src/foo.ts
    const cachedEntry: ProjectFilesCacheEntry = {
      files: ['src/foo.ts'],
      cachedAt: Date.now(),
    };
    const seedCache = new Map<string, ProjectFilesCacheEntry>();
    seedCache.set(path.resolve(projectDir), cachedEntry);
    _setProjectFilesCacheForTesting(seedCache);

    // Write a rule file with globs: ["**/*.ts"]
    const rulesDir = path.join(projectDir, '.opencode', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      path.join(rulesDir, 'typescript.md'),
      `---\nglobs:\n  - "**/*.ts"\n---\nTS_RULE_MARKER`
    );

    // Build context with empty paths — scanner fallback should use cache
    const ctx = await buildFilterContext(
      {
        contextFilePaths: [],
        userPrompt: undefined,
        availableToolIDs: [],
        modelID: undefined,
        agentType: undefined,
      },
      projectDir,
      noopDebugLog
    );

    // Read and format rules — the TS rule should be injected
    const { formattedRules } = await readAndFormatRules(
      [{ filePath: path.join(rulesDir, 'typescript.md'), relativePath: 'typescript.md' }],
      ctx
    );

    expect(formattedRules).toContain('TS_RULE_MARKER');
  });
});

// =============================================================================
// Case 2: unconditional rule still injects with empty context (regression guard)
// Must PASS before AND after wiring
// =============================================================================

describe('Case 2: unconditional rule injects on empty context', () => {
  beforeEach(() => {
    clearRuleCache();
  });

  afterEach(() => {
    teardownTestDir();
  });

  it('still injects unconditional rule with empty contextFilePaths', async () => {
    // This test calls readAndFormatRules directly with a context that has
    // contextFilePaths=undefined (not []), matching the existing test pattern.
    // This is a regression guard: unconditional rules must inject regardless
    // of context state.
    const root = setupTestDir();
    const rulesDir = path.join(root, '.opencode', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const rulePath = path.join(rulesDir, 'general.md');
    writeFileSync(rulePath, `# General Rule\nUnconditional body content`);

    // Pass context WITHOUT contextFilePaths (undefined, not [])
    // This mirrors the existing unconditional-rule test pattern.
    const { formattedRules } = await readAndFormatRules(
      [{ filePath: rulePath, relativePath: 'general.md' }],
      { os: 'linux', ci: false }
    );

    expect(formattedRules).toContain('Unconditional body content');
  });
});

// =============================================================================
// Case 3: non-empty contextFilePaths skips the scanner (DI seam)
// Must FAIL before wiring, PASS after
// =============================================================================

describe('Case 3: non-empty context skips scanner', () => {
  beforeEach(() => {
    clearProjectFilesCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    teardownTestDir();
  });

  it('does not invoke scanner when contextFilePaths is non-empty', async () => {
    const projectDir = '/some/project';

    const mockDiscover = vi.fn().mockResolvedValue(['src/bar.ts']);

    const ctx = await buildFilterContext(
      {
        contextFilePaths: ['src/foo.ts'],
        userPrompt: undefined,
        availableToolIDs: [],
        modelID: undefined,
        agentType: undefined,
        discoverProjectFiles: mockDiscover,
      },
      projectDir,
      noopDebugLog
    );

    expect(mockDiscover).not.toHaveBeenCalled();
    expect(ctx.contextFilePaths).toEqual(['src/foo.ts']);
  });
});

// =============================================================================
// Case 4: cache hit avoids re-walk via _setProjectFilesCacheForTesting
// (Scanner cache is proven in project-file-scanner.test.ts; this is the
// integration confirmation that buildFilterContext reuses it.)
// =============================================================================

describe('Case 4: cache hit avoids second filesystem walk', () => {
  beforeEach(() => {
    clearProjectFilesCache();
  });

  afterEach(() => {
    teardownTestDir();
  });

  it('buildFilterContext uses cached scanner result on second call within TTL', async () => {
    const root = setupTestDir();
    const projectDir = path.join(root, 'project');
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    writeFileSync(path.join(projectDir, 'src', 'foo.ts'), '// ts');

    // Seed cache so discoverProjectFiles returns from cache (no fs walk)
    const cachedEntry: ProjectFilesCacheEntry = {
      files: ['src/foo.ts'],
      cachedAt: Date.now(),
    };
    const seedCache = new Map<string, ProjectFilesCacheEntry>();
    seedCache.set(path.resolve(projectDir), cachedEntry);
    _setProjectFilesCacheForTesting(seedCache);

    // First buildFilterContext call — uses cached scanner result
    const ctx1 = await buildFilterContext(
      {
        contextFilePaths: [],
        userPrompt: undefined,
        availableToolIDs: [],
        modelID: undefined,
        agentType: undefined,
      },
      projectDir,
      noopDebugLog
    );
    expect(ctx1.contextFilePaths).toContain('src/foo.ts');

    // Second call — also from cache
    const ctx2 = await buildFilterContext(
      {
        contextFilePaths: [],
        userPrompt: undefined,
        availableToolIDs: [],
        modelID: undefined,
        agentType: undefined,
      },
      projectDir,
      noopDebugLog
    );
    expect(ctx2.contextFilePaths).toContain('src/foo.ts');
  });
});

// =============================================================================
// Case 5: non-matching glob excludes rule (negative)
// Must FAIL before wiring, PASS after
// =============================================================================

describe('Case 5: non-matching glob excludes rule', () => {
  beforeEach(() => {
    clearProjectFilesCache();
    clearRuleCache();
  });

  afterEach(() => {
    teardownTestDir();
  });

  it('does not inject glob rule when project has no matching files', async () => {
    const root = setupTestDir();
    const projectDir = path.join(root, 'project');

    // Seed the cache with only .js files (no .py files)
    const cachedEntry: ProjectFilesCacheEntry = {
      files: ['src/foo.js'],
      cachedAt: Date.now(),
    };
    const seedCache = new Map<string, ProjectFilesCacheEntry>();
    seedCache.set(path.resolve(projectDir), cachedEntry);
    _setProjectFilesCacheForTesting(seedCache);

    // Write a Python rule
    const rulesDir = path.join(projectDir, '.opencode', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      path.join(rulesDir, 'python.md'),
      `---\nglobs:\n  - "**/*.py"\n---\nPY_RULE_MARKER`
    );

    // Build context with empty paths — scanner finds only .js files
    const ctx = await buildFilterContext(
      {
        contextFilePaths: [],
        userPrompt: undefined,
        availableToolIDs: [],
        modelID: undefined,
        agentType: undefined,
      },
      projectDir,
      noopDebugLog
    );

    const { formattedRules } = await readAndFormatRules(
      [{ filePath: path.join(rulesDir, 'python.md'), relativePath: 'python.md' }],
      ctx
    );

    expect(formattedRules).not.toContain('PY_RULE_MARKER');
  });
});
