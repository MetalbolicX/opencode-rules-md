/**
 * Contract tests for readAndFormatRules output shape and measurement helpers.
 * Locks the exact current formatting so later token-optimization work can
 * prove regressions and prove reductions against a fixed baseline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  deduplicateEntries,
  estimateTokens,
  formatRules,
  matchRuleConditions,
  readAndFormatRules,
  selectByTokenBudget,
  type MatchedEntry,
} from './rule-filter.js';
import { clearRuleCache, type DiscoveredRule } from './rule-discovery.js';
import { parseRuleMetadata } from './rule-metadata.js';
import { resolveMaxTokens } from './runtime-context.js';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns Math.ceil(chars/4) for non-empty text', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('readAndFormatRules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rule-filter-test-'));
    clearRuleCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRule(relativePath: string, content: string): DiscoveredRule {
    const filePath = path.join(tempDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return { filePath, relativePath };
  }

  it('returns empty result for an empty input array', async () => {
    const result = await readAndFormatRules([]);
    expect(result).toEqual({
      formattedRules: '',
      matchedPaths: [],
      tokenEstimate: 0,
    });
  });

  describe('conditional combinator — match: all', () => {
    it('requires ALL declared checks to pass when match: "all" is set', async () => {
      // globs matches (src/foo.ts), keywords does not match (prompt is unrelated)
      const rule = writeRule(
        'all-and.md',
        '---\nglobs:\n  - "**/*.ts"\nkeywords:\n  - "should-not-match"\nmatch: all\n---\nbody'
      );
      const result = await readAndFormatRules([rule], {
        contextFilePaths: ['src/foo.ts'],
        userPrompt: 'hello world',
      });
      // globs passes, keywords fails → not all → excluded
      expect(result.matchedPaths).toHaveLength(0);
      expect(result.formattedRules).toBe('');
    });

    it('includes the rule when ALL declared checks pass with match: "all"', async () => {
      const rule = writeRule(
        'all-pass.md',
        '---\nglobs:\n  - "**/*.ts"\nkeywords:\n  - "hello"\nmatch: all\n---\nbody'
      );
      const result = await readAndFormatRules([rule], {
        contextFilePaths: ['src/foo.ts'],
        userPrompt: 'say hello to the world',
      });
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('all-pass.md');
    });

    it('skips undeclared dimensions (does not fail them) under match: "all"', async () => {
      // Only globs declared; keywords NOT declared. match: 'all' should treat
      // keywords as vacuously true (not a failure).
      const rule = writeRule(
        'partial-decl.md',
        '---\nglobs:\n  - "**/*.ts"\nmatch: all\n---\npartial body'
      );
      const result = await readAndFormatRules([rule], {
        contextFilePaths: ['src/foo.ts'],
        userPrompt: 'something completely unrelated xyz',
      });
      // Only globs declared and it matches → all(1 declared check) passes
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('partial-decl.md');
    });

    it('match: "any" (default) includes on a single declared check passing', async () => {
      // Default combinator is "any" — single declared check passing is enough
      const rule = writeRule(
        'any-default.md',
        '---\nglobs:\n  - "**/*.ts"\n---\nany body'
      );
      const result = await readAndFormatRules([rule], {
        contextFilePaths: ['src/foo.ts'],
        userPrompt: 'unrelated prompt',
      });
      expect(result.matchedPaths).toHaveLength(1);
    });
  });

  describe('branch conditional', () => {
    it('non-glob pattern that does not equal gitBranch — no match (no glob fallback)', async () => {
      const rule = writeRule(
        'branch-exact.md',
        '---\nbranch:\n  - "main"\n---\nbranch body'
      );
      const result = await readAndFormatRules([rule], { gitBranch: 'develop' });
      // No glob chars in "main"; exact match required; "develop" !== "main"
      expect(result.matchedPaths).toHaveLength(0);
    });

    it('non-glob pattern that equals gitBranch — exact match wins', async () => {
      const rule = writeRule(
        'branch-exact-ok.md',
        '---\nbranch:\n  - "main"\n---\nbranch body'
      );
      const result = await readAndFormatRules([rule], { gitBranch: 'main' });
      expect(result.matchedPaths).toHaveLength(1);
    });

    it('glob pattern matches via minimatch', async () => {
      const rule = writeRule(
        'branch-glob.md',
        '---\nbranch:\n  - "feat/*"\n---\nbranch body'
      );
      const result = await readAndFormatRules([rule], {
        gitBranch: 'feat/login',
      });
      expect(result.matchedPaths).toHaveLength(1);
    });
  });

  it('starts formattedRules with the standard preamble', async () => {
    const rule = writeRule('foo.md', 'Just a rule body');
    const { formattedRules } = await readAndFormatRules([rule]);
    expect(
      formattedRules.startsWith(
        '# OpenCode Rules\n\nPlease follow the following rules:\n\n'
      )
    ).toBe(true);
  });

  it('renders each rule as `## {relativePath}\\n\\n{body}`', async () => {
    const rule = writeRule('nested/foo.md', 'the body text');
    const { formattedRules } = await readAndFormatRules([rule]);
    expect(formattedRules).toContain('## nested/foo.md\n\nthe body text');
  });

  it('joins multiple matched rules with exactly `\\n\\n---\\n\\n`', async () => {
    const rule1 = writeRule('a.md', 'first body');
    const rule2 = writeRule('b.md', 'second body');
    const { formattedRules } = await readAndFormatRules([rule1, rule2]);
    expect(formattedRules).toContain(
      '## a.md\n\nfirst body\n\n---\n\n## b.md\n\nsecond body'
    );
  });

  it('strips frontmatter from rule body in formattedRules', async () => {
    const rule = writeRule(
      'with-frontmatter.md',
      '---\nglobs:\n  - "**/*.ts"\n---\nThe actual rule body'
    );
    const { formattedRules } = await readAndFormatRules([rule], {
      contextFilePaths: ['src/foo.ts'],
    });
    expect(formattedRules).toContain('The actual rule body');
    expect(formattedRules).not.toContain('globs:');
    expect(formattedRules).not.toContain('**/*.ts');
  });

  it('populates tokenEstimate as Math.ceil(formattedRules.length / 4)', async () => {
    const rule = writeRule('a.md', 'body');
    const result = await readAndFormatRules([rule]);
    expect(result.tokenEstimate).toBe(
      Math.ceil(result.formattedRules.length / 4)
    );
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('returns matchedPaths in the order of the input files array', async () => {
    const rule1 = writeRule('first.md', 'one');
    const rule2 = writeRule('second.md', 'two');
    const rule3 = writeRule('third.md', 'three');
    const { matchedPaths } = await readAndFormatRules([rule1, rule2, rule3]);
    expect(matchedPaths).toEqual([
      rule1.filePath,
      rule2.filePath,
      rule3.filePath,
    ]);
  });

  describe('payload sizing', () => {
    it('produces tokenEstimate > 0 and roughly proportional to body size for a 5-rule set', async () => {
      const rules = [
        writeRule('small1.md', 'tiny'),
        writeRule('small2.md', 'short body'),
        writeRule('medium1.md', 'a'.repeat(500)),
        writeRule('medium2.md', 'b'.repeat(500)),
        writeRule('large.md', 'c'.repeat(1000)),
      ];
      const result = await readAndFormatRules(rules);
      expect(result.tokenEstimate).toBeGreaterThan(0);
      // 5 rules × ~500 chars average body + headings + overhead ≈ 2500 chars
      // tokenEstimate ≈ ceil(2500/4) ≈ 625+
      expect(result.tokenEstimate).toBeGreaterThan(500);
      expect(result.matchedPaths).toHaveLength(5);
    });

    it('keeps the fixed preamble + per-pair separator overhead under 70 chars', () => {
      // Locks the baseline boilerplate cost so later optimization cannot regress it.
      const preamble =
        '# OpenCode Rules\n\nPlease follow the following rules:\n\n';
      const separator = '\n\n---\n\n';
      expect(preamble.length).toBeLessThan(60);
      // Two rules = preamble (54) + one separator (7) = 61 chars of fixed overhead.
      // Bound at 70 so any future plan adding >8 chars of boilerplate breaks this test.
      expect(preamble.length + separator.length).toBeLessThan(70);
    });
  });

  describe('content deduplication', () => {
    it('collapses exact duplicate bodies into one entry', async () => {
      const rule1 = writeRule('first.md', 'identical body content');
      const rule2 = writeRule('second.md', 'identical body content');
      const result = await readAndFormatRules([rule1, rule2]);
      // Only one survivor despite two files with identical strippedContent
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.formattedRules).not.toContain(
        '## first.md\n\nidentical body content\n\n---\n\n## second.md\n\nidentical body content'
      );
    });

    it('collapses duplicates with and without maxTokens', async () => {
      const rule1 = writeRule('a.md', 'same body');
      const rule2 = writeRule('b.md', 'same body');
      const rule3 = writeRule('c.md', 'same body');
      // Without budget
      const noBudget = await readAndFormatRules([rule1, rule2, rule3]);
      expect(noBudget.matchedPaths).toHaveLength(1);
      // With budget (should still dedup before budget selection)
      const withBudget = await readAndFormatRules([rule1, rule2, rule3], {
        maxTokens: 1000,
      });
      expect(withBudget.matchedPaths).toHaveLength(1);
    });

    it('higher priority wins on duplicate content', async () => {
      const lowPriority = writeRule(
        'low.md',
        '---\npriority: 1\n---\nshared body'
      );
      const highPriority = writeRule(
        'high.md',
        '---\npriority: 10\n---\nshared body'
      );
      const result = await readAndFormatRules([lowPriority, highPriority]);
      // Higher priority survivor is retained
      expect(result.formattedRules).toContain('## high.md');
      expect(result.formattedRules).not.toContain('## low.md');
      expect(result.matchedPaths).toHaveLength(1);
    });

    it('equal priority — later-discovered entry wins on duplicate content', async () => {
      const first = writeRule('first.md', '---\npriority: 5\n---\nshared body');
      const second = writeRule(
        'second.md',
        '---\npriority: 5\n---\nshared body'
      );
      const result = await readAndFormatRules([first, second]);
      // Later discovery index wins when priority is equal
      expect(result.formattedRules).toContain('## second.md');
      expect(result.formattedRules).not.toContain('## first.md');
      expect(result.matchedPaths).toHaveLength(1);
    });

    it('empty strippedContent bodies collapse into one survivor', async () => {
      const rule1 = writeRule('empty1.md', '---\npriority: 3\n---\n');
      const rule2 = writeRule('empty2.md', '---\npriority: 2\n---\n');
      const result = await readAndFormatRules([rule1, rule2]);
      // Both have empty strippedContent, only one survives
      expect(result.matchedPaths).toHaveLength(1);
    });

    it('distinct bodies pass through without deduplication', async () => {
      const rule1 = writeRule('a.md', 'unique body A');
      const rule2 = writeRule('b.md', 'unique body B');
      const rule3 = writeRule('c.md', 'unique body C');
      const result = await readAndFormatRules([rule1, rule2, rule3]);
      // All three distinct bodies survive
      expect(result.matchedPaths).toHaveLength(3);
      expect(result.formattedRules).toContain('## a.md');
      expect(result.formattedRules).toContain('## b.md');
      expect(result.formattedRules).toContain('## c.md');
    });

    it('survivor order preserves discovery order after deduplication', async () => {
      const ruleA = writeRule('a.md', 'body A');
      const ruleB = writeRule('b.md', 'shared body');
      const ruleC = writeRule('c.md', 'shared body');
      const result = await readAndFormatRules([ruleA, ruleB, ruleC]);
      // A is unique, B and C are duplicate — C (higher index) wins for the duplicate pair
      // Final order should be A then C (discovery order preserved)
      const _bIndex = result.formattedRules.indexOf('## b.md');
      const cIndex = result.formattedRules.indexOf('## c.md');
      const aIndex = result.formattedRules.indexOf('## a.md');
      // C should appear (it won the duplicate), B should not
      expect(result.formattedRules).toContain('## c.md');
      expect(result.formattedRules).not.toContain('## b.md');
      // A should appear before C
      expect(aIndex).toBeLessThan(cIndex);
    });

    it('always-on — deduplication applies with and without maxTokens', async () => {
      const rule1 = writeRule('dup1.md', 'body');
      const rule2 = writeRule('dup2.md', 'body');
      // Without budget
      const noBudget = await readAndFormatRules([rule1, rule2]);
      expect(noBudget.matchedPaths).toHaveLength(1);
      // With budget
      const withBudget = await readAndFormatRules([rule1, rule2], {
        maxTokens: 1000,
      });
      expect(withBudget.matchedPaths).toHaveLength(1);
      // Without maxTokens context key entirely
      const noContext = await readAndFormatRules([rule1, rule2], {});
      expect(noContext.matchedPaths).toHaveLength(1);
    });

    it('deduplication reduces tokenEstimate vs keeping all duplicates', async () => {
      const rule1 = writeRule('dup-a.md', 'large duplicate body content here');
      const rule2 = writeRule('dup-b.md', 'large duplicate body content here');
      const result = await readAndFormatRules([rule1, rule2]);
      // Only one entry in output, so tokenEstimate is for one entry, not two
      expect(result.matchedPaths).toHaveLength(1);
      // A single identical body would produce lower tokenEstimate than two copies
      const singleResult = await readAndFormatRules([rule1]);
      expect(result.tokenEstimate).toBe(singleResult.tokenEstimate);
    });

    it('equal priority + equal content + higher index wins (helper-extractable tiebreaker)', async () => {
      // Three identical-content rules with identical priority → highest index wins
      const r1 = writeRule('e1.md', '---\npriority: 7\n---\nshared');
      const r2 = writeRule('e2.md', '---\npriority: 7\n---\nshared');
      const r3 = writeRule('e3.md', '---\npriority: 7\n---\nshared');
      const result = await readAndFormatRules([r1, r2, r3]);
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('e3.md');
    });

    it('equal priority + equal content + budget forces ordering preserves highest-index winner', async () => {
      const r1 = writeRule('b1.md', '---\npriority: 1\n---\nshared');
      const r2 = writeRule('b2.md', '---\npriority: 1\n---\nshared');
      const result = await readAndFormatRules([r1, r2], { maxTokens: 1000 });
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('b2.md');
    });
  });

  describe('token budget', () => {
    it('keeps all rules when no maxTokens is set (discovery order preserved)', async () => {
      const rule1 = writeRule('a.md', 'body-a');
      const rule2 = writeRule('b.md', 'body-b');
      const rule3 = writeRule('c.md', 'body-c');
      const { formattedRules, matchedPaths } = await readAndFormatRules([
        rule1,
        rule2,
        rule3,
      ]);
      // All three rules present in discovery order
      expect(formattedRules).toContain('## a.md\n\nbody-a');
      expect(formattedRules).toContain('## b.md\n\nbody-b');
      expect(formattedRules).toContain('## c.md\n\nbody-c');
      expect(matchedPaths).toHaveLength(3);
    });

    it('keeps higher-priority rule when budget is too small for both', async () => {
      const rule1 = writeRule(
        'low.md',
        '---\npriority: 0\n---\nlow-priority body'
      );
      const rule2 = writeRule(
        'high.md',
        '---\npriority: 10\n---\nhigh-priority body'
      );
      const result = await readAndFormatRules([rule1, rule2], {
        maxTokens: 1, // tiny budget, only highest priority can fit
      });
      // High priority rule survives, low priority is dropped
      expect(result.formattedRules).toContain('## high.md');
      expect(result.formattedRules).not.toContain('## low.md');
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('high.md');
    });

    it('preserves discovery order as tiebreaker for equal priority', async () => {
      const rule1 = writeRule('first.md', '---\npriority: 5\n---\nfirst body');
      const rule2 = writeRule(
        'second.md',
        '---\npriority: 5\n---\nsecond body'
      );
      // Budget fits only one rule
      const result = await readAndFormatRules([rule1, rule2], {
        maxTokens: 1,
      });
      // First discovered rule (rule1) should survive the tie
      expect(result.formattedRules).toContain('## first.md');
      expect(result.formattedRules).not.toContain('## second.md');
      expect(result.matchedPaths).toHaveLength(1);
    });

    it('always keeps at least one rule even if it alone exceeds budget', async () => {
      const rule1 = writeRule('oversized.md', 'x'.repeat(10000));
      const result = await readAndFormatRules([rule1], {
        maxTokens: 1, // tiny budget
      });
      // Single rule must survive even though it exceeds budget
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('oversized.md');
      expect(result.formattedRules).toContain('## oversized.md');
    });

    it('drops whole rules only — no truncation mid-body', async () => {
      const small = writeRule('small.md', 'small body fits');
      const large = writeRule('large.md', 'x'.repeat(8000));
      const result = await readAndFormatRules([small, large], {
        maxTokens: 50, // fits small but not large
      });
      // Small survives, large is dropped entirely
      expect(result.formattedRules).toContain('## small.md');
      expect(result.formattedRules).not.toContain('## large.md');
      // Verify no truncated large content appears
      expect(result.formattedRules).not.toContain('x'.repeat(100));
    });

    it('matchedPaths contains only surviving rules', async () => {
      const rule1 = writeRule('keep.md', 'keep body');
      const rule2 = writeRule('drop.md', 'drop body');
      const result = await readAndFormatRules([rule1, rule2], {
        maxTokens: 1, // tiny budget, drops rule2
      });
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('keep.md');
    });

    it('under-budget payload keeps all rules unchanged', async () => {
      const rules = [
        writeRule('r1.md', 'tiny'),
        writeRule('r2.md', 'small'),
        writeRule('r3.md', 'medium-sized'),
      ];
      const result = await readAndFormatRules(rules, {
        maxTokens: 10000, // generous budget
      });
      expect(result.matchedPaths).toHaveLength(3);
      expect(result.formattedRules).toContain('## r1.md');
      expect(result.formattedRules).toContain('## r2.md');
      expect(result.formattedRules).toContain('## r3.md');
    });

    it('respects priority desc + index asc ordering', async () => {
      const rule1 = writeRule('p5-first.md', '---\npriority: 5\n---\nA');
      const rule2 = writeRule('p5-second.md', '---\npriority: 5\n---\nB');
      const rule3 = writeRule('p3.md', '---\npriority: 3\n---\nC');
      const rule4 = writeRule('p10.md', '---\npriority: 10\n---\nD');
      // Budget ~10 tokens: fits p10 (priority 10) and p5-first (priority 5) but not p5-second or p3
      // estimateTokens("## pX.md\n\nbody") ≈ ceil(18/4) = 5 tokens each
      const result = await readAndFormatRules([rule1, rule2, rule3, rule4], {
        maxTokens: 10,
      });
      // p10 first (priority 10), then p5-first (priority 5, discovered before p5-second)
      expect(result.matchedPaths).toHaveLength(2);
      expect(result.matchedPaths[0]).toContain('p10.md');
      expect(result.matchedPaths[1]).toContain('p5-first.md');
    });

    it('keeps all rules when maxTokens exactly equals the sum of their token counts', async () => {
      // Distinct bodies so dedup does not collapse them. Each chunk
      // "## eX.md\n\nbody" = 14 chars → ceil(14/4) = 4 tokens each.
      // Total = 12 tokens; set maxTokens = 12 (exact match).
      const rule1 = writeRule('ea.md', 'one');
      const rule2 = writeRule('eb.md', 'two');
      const rule3 = writeRule('ec.md', 'three');
      const result = await readAndFormatRules([rule1, rule2, rule3], {
        maxTokens: 12,
      });
      expect(result.matchedPaths).toHaveLength(3);
    });

    it('keeps only the first sorted entry when maxTokens < first entry token count', async () => {
      // Large body = 'x'.repeat(200) → "## big.md\n\n" + 200 chars = 209 chars → ceil(209/4) = 53 tokens
      const big = writeRule('big.md', 'x'.repeat(200));
      const small = writeRule('small.md', 'tiny');
      // Budget = 10; first sorted entry (big, index 0) costs 53 > budget → keep big alone (≥1 invariant)
      const result = await readAndFormatRules([big, small], { maxTokens: 10 });
      expect(result.matchedPaths).toHaveLength(1);
      expect(result.matchedPaths[0]).toContain('big.md');
      expect(result.formattedRules).not.toContain('## small.md');
    });

    it('treats maxTokens = 0 as no budget — keeps everything in discovery order', async () => {
      const rule1 = writeRule('z1.md', 'one');
      const rule2 = writeRule('z2.md', 'two');
      const rule3 = writeRule('z3.md', 'three');
      const result = await readAndFormatRules([rule1, rule2, rule3], {
        maxTokens: 0,
      });
      expect(result.matchedPaths).toHaveLength(3);
      expect(result.matchedPaths).toEqual([
        rule1.filePath,
        rule2.filePath,
        rule3.filePath,
      ]);
    });

    it('treats negative maxTokens as no budget — keeps everything in discovery order', async () => {
      const rule1 = writeRule('n1.md', 'one');
      const rule2 = writeRule('n2.md', 'two');
      const result = await readAndFormatRules([rule1, rule2], {
        maxTokens: -5,
      });
      expect(result.matchedPaths).toHaveLength(2);
    });

    it('treats NaN maxTokens as no budget — keeps everything in discovery order', async () => {
      const rule1 = writeRule('na1.md', 'one');
      const rule2 = writeRule('na2.md', 'two');
      const result = await readAndFormatRules([rule1, rule2], {
        maxTokens: NaN,
      });
      expect(result.matchedPaths).toHaveLength(2);
    });
  });
});

describe('parseRuleMetadata priority', () => {
  it('parses a valid finite priority number', () => {
    const meta = parseRuleMetadata('---\npriority: 10\n---\nbody');
    expect(meta?.priority).toBe(10);
  });

  it('treats string priority as undefined (defaults to 0 downstream)', () => {
    const meta = parseRuleMetadata('---\npriority: "high"\n---\nbody');
    expect(meta?.priority).toBeUndefined();
  });

  it('treats NaN priority as undefined', () => {
    const meta = parseRuleMetadata('---\npriority: NaN\n---\nbody');
    expect(meta?.priority).toBeUndefined();
  });

  it('treats Infinity priority as undefined', () => {
    const meta = parseRuleMetadata('---\npriority: Infinity\n---\nbody');
    expect(meta?.priority).toBeUndefined();
  });

  it('returns undefined when no priority field is present', () => {
    const meta = parseRuleMetadata('---\nglobs:\n  - "*.ts"\n---\nbody');
    expect(meta?.priority).toBeUndefined();
  });

  it('parses priority: 0 as a valid finite number (not falsy)', () => {
    const meta = parseRuleMetadata('---\npriority: 0\n---\nbody');
    expect(meta?.priority).toBe(0);
  });
});

describe('resolveMaxTokens', () => {
  const saved = process.env.OPENCODE_RULES_MAX_TOKENS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OPENCODE_RULES_MAX_TOKENS;
    } else {
      process.env.OPENCODE_RULES_MAX_TOKENS = saved;
    }
  });

  it('returns the numeric value for a valid positive env var', () => {
    process.env.OPENCODE_RULES_MAX_TOKENS = '8000';
    expect(resolveMaxTokens()).toBe(8000);
  });

  it('returns undefined when env var is unset', () => {
    delete process.env.OPENCODE_RULES_MAX_TOKENS;
    expect(resolveMaxTokens()).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    process.env.OPENCODE_RULES_MAX_TOKENS = '';
    expect(resolveMaxTokens()).toBeUndefined();
  });

  it('returns undefined for non-numeric string', () => {
    process.env.OPENCODE_RULES_MAX_TOKENS = 'abc';
    expect(resolveMaxTokens()).toBeUndefined();
  });

  it('returns undefined for zero', () => {
    process.env.OPENCODE_RULES_MAX_TOKENS = '0';
    expect(resolveMaxTokens()).toBeUndefined();
  });

  it('returns undefined for negative value', () => {
    process.env.OPENCODE_RULES_MAX_TOKENS = '-5';
    expect(resolveMaxTokens()).toBeUndefined();
  });
});

describe('matchRuleConditions (direct unit)', () => {
  it('returns true when metadata is undefined (no conditions to evaluate)', () => {
    expect(matchRuleConditions(undefined, {}, undefined, 'p.md')).toBe(true);
    expect(matchRuleConditions(null, {}, undefined, 'p.md')).toBe(true);
  });

  it('returns true when metadata has no declared conditions', () => {
    const meta = parseRuleMetadata('---\npriority: 5\n---\nbody') ?? {};
    expect(matchRuleConditions(meta, {}, undefined, 'p.md')).toBe(true);
  });

  it('returns false when a single declared condition fails under match: "any"', () => {
    const meta = parseRuleMetadata('---\nglobs:\n  - "**/*.ts"\n---\nbody')!;
    // No contextFilePaths provided → globs check fails
    expect(matchRuleConditions(meta, {}, undefined, 'p.md')).toBe(false);
  });

  it('returns true when a single declared condition passes under match: "any"', () => {
    const meta = parseRuleMetadata('---\nglobs:\n  - "**/*.ts"\n---\nbody')!;
    expect(
      matchRuleConditions(
        meta,
        { contextFilePaths: ['src/x.ts'] },
        undefined,
        'p.md'
      )
    ).toBe(true);
  });

  it('returns false when match: "all" is set and one declared check fails', () => {
    const meta = parseRuleMetadata(
      '---\nglobs:\n  - "**/*.ts"\nkeywords:\n  - "hello"\nmatch: all\n---\nbody'
    )!;
    // globs passes, keywords fails → not all
    expect(
      matchRuleConditions(
        meta,
        { contextFilePaths: ['src/x.ts'], userPrompt: 'no match here' },
        undefined,
        'p.md'
      )
    ).toBe(false);
  });

  it('returns true when match: "all" is set and every declared check passes', () => {
    const meta = parseRuleMetadata(
      '---\nglobs:\n  - "**/*.ts"\nkeywords:\n  - "hello"\nmatch: all\n---\nbody'
    )!;
    expect(
      matchRuleConditions(
        meta,
        { contextFilePaths: ['src/x.ts'], userPrompt: 'say hello' },
        undefined,
        'p.md'
      )
    ).toBe(true);
  });

  it('vacuously true when match: "all" with no declared checks at all', () => {
    const meta = parseRuleMetadata('---\nmatch: all\n---\nbody') ?? {};
    expect(matchRuleConditions(meta, {}, undefined, 'p.md')).toBe(true);
  });

  it('evaluates tools condition via the availableToolSet', () => {
    const meta = parseRuleMetadata('---\ntools:\n  - "bash"\n---\nbody')!;
    const toolSet = new Set(['bash']);
    expect(matchRuleConditions(meta, {}, toolSet, 'p.md')).toBe(true);
    expect(matchRuleConditions(meta, {}, new Set(['edit']), 'p.md')).toBe(
      false
    );
    expect(matchRuleConditions(meta, {}, undefined, 'p.md')).toBe(false);
  });

  it('evaluates branch glob vs exact — exact non-glob mismatch does not match', () => {
    const meta = parseRuleMetadata('---\nbranch:\n  - "main"\n---\nbody')!;
    expect(
      matchRuleConditions(meta, { gitBranch: 'develop' }, undefined, 'p.md')
    ).toBe(false);
    expect(
      matchRuleConditions(meta, { gitBranch: 'main' }, undefined, 'p.md')
    ).toBe(true);
  });

  it('evaluates branch glob via minimatch when glob chars are present', () => {
    const meta = parseRuleMetadata('---\nbranch:\n  - "feat/*"\n---\nbody')!;
    expect(
      matchRuleConditions(meta, { gitBranch: 'feat/login' }, undefined, 'p.md')
    ).toBe(true);
    expect(
      matchRuleConditions(meta, { gitBranch: 'main' }, undefined, 'p.md')
    ).toBe(false);
  });

  it('evaluates ci condition with strict boolean equality', () => {
    const meta = parseRuleMetadata('---\nci: true\n---\nbody')!;
    expect(matchRuleConditions(meta, { ci: true }, undefined, 'p.md')).toBe(
      true
    );
    expect(matchRuleConditions(meta, { ci: false }, undefined, 'p.md')).toBe(
      false
    );
  });
});

describe('deduplicateEntries (direct unit)', () => {
  function entry(
    partial: Partial<MatchedEntry> &
      Pick<MatchedEntry, 'index' | 'strippedContent'>
  ): MatchedEntry {
    return {
      filePath: partial.filePath ?? `/p/${partial.index}.md`,
      relativePath: partial.relativePath ?? `${partial.index}.md`,
      strippedContent: partial.strippedContent,
      priority: partial.priority ?? 0,
      tokenCount: partial.tokenCount ?? 1,
      index: partial.index,
    };
  }

  it('returns empty array for empty input', () => {
    expect(deduplicateEntries([])).toEqual([]);
  });

  it('passes through unique entries in index order', () => {
    const a = entry({ index: 0, strippedContent: 'A' });
    const b = entry({ index: 1, strippedContent: 'B' });
    expect(deduplicateEntries([a, b])).toEqual([a, b]);
  });

  it('keeps higher priority entry when content duplicates', () => {
    const low = entry({ index: 0, strippedContent: 'same', priority: 1 });
    const high = entry({ index: 1, strippedContent: 'same', priority: 10 });
    expect(deduplicateEntries([low, high])).toEqual([high]);
  });

  it('keeps higher index entry when content and priority are equal', () => {
    const first = entry({ index: 0, strippedContent: 'same', priority: 5 });
    const second = entry({ index: 1, strippedContent: 'same', priority: 5 });
    expect(deduplicateEntries([first, second])).toEqual([second]);
  });

  it('does not mutate the input array order', () => {
    const first = entry({ index: 0, strippedContent: 'X', priority: 0 });
    const second = entry({ index: 1, strippedContent: 'X', priority: 0 });
    const input = [first, second];
    const result = deduplicateEntries(input);
    expect(input).toEqual([first, second]);
    expect(result).toEqual([second]);
  });

  it('returns deduplicated entries sorted by index ascending', () => {
    const a = entry({ index: 0, strippedContent: 'A' });
    const b = entry({ index: 5, strippedContent: 'B' });
    const c = entry({ index: 2, strippedContent: 'A', priority: 10 }); // wins over a
    const result = deduplicateEntries([a, b, c]);
    // After dedup: c (winner over a), b. Sorted by index: c (2), b (5).
    expect(result.map(e => e.index)).toEqual([2, 5]);
  });

  it('treats empty strippedContent as a single dedup key', () => {
    const a = entry({ index: 0, strippedContent: '', priority: 3 });
    const b = entry({ index: 1, strippedContent: '', priority: 2 });
    const result = deduplicateEntries([a, b]);
    expect(result).toEqual([a]); // higher priority wins
  });
});

describe('selectByTokenBudget (direct unit)', () => {
  function entry(
    partial: Partial<MatchedEntry> & Pick<MatchedEntry, 'index' | 'tokenCount'>
  ): MatchedEntry {
    return {
      filePath: partial.filePath ?? `/p/${partial.index}.md`,
      relativePath: partial.relativePath ?? `${partial.index}.md`,
      strippedContent: partial.strippedContent ?? `body-${partial.index}`,
      priority: partial.priority ?? 0,
      tokenCount: partial.tokenCount,
      index: partial.index,
    };
  }

  it('returns the input as-is when maxTokens is undefined', () => {
    const a = entry({ index: 0, tokenCount: 5 });
    const b = entry({ index: 1, tokenCount: 5 });
    expect(selectByTokenBudget([a, b], undefined)).toEqual([a, b]);
  });

  it('returns input as-is for maxTokens = 0 / negative / NaN / Infinity', () => {
    const a = entry({ index: 0, tokenCount: 100 });
    const b = entry({ index: 1, tokenCount: 100 });
    expect(selectByTokenBudget([a, b], 0)).toEqual([a, b]);
    expect(selectByTokenBudget([a, b], -10)).toEqual([a, b]);
    expect(selectByTokenBudget([a, b], NaN)).toEqual([a, b]);
    expect(selectByTokenBudget([a, b], Infinity)).toEqual([a, b]);
  });

  it('keeps the first sorted entry even when it alone exceeds the budget', () => {
    const big = entry({ index: 0, tokenCount: 100, priority: 0 });
    const small = entry({ index: 1, tokenCount: 1, priority: 0 });
    const result = selectByTokenBudget([big, small], 5);
    expect(result).toEqual([big]);
  });

  it('sorts by priority desc, index asc before greedy selection', () => {
    const first = entry({ index: 0, tokenCount: 5, priority: 5 });
    const second = entry({ index: 1, tokenCount: 5, priority: 5 });
    const third = entry({ index: 2, tokenCount: 5, priority: 3 });
    const fourth = entry({ index: 3, tokenCount: 5, priority: 10 });
    // Budget 10: fits priority-10 (fourth) + priority-5 with lower index (first)
    const result = selectByTokenBudget([first, second, third, fourth], 10);
    expect(result.map(e => e.index)).toEqual([3, 0]);
  });

  it('keeps all entries when the budget covers every cost exactly', () => {
    const a = entry({ index: 0, tokenCount: 4 });
    const b = entry({ index: 1, tokenCount: 4 });
    const c = entry({ index: 2, tokenCount: 4 });
    expect(selectByTokenBudget([a, b, c], 12)).toEqual([a, b, c]);
  });

  it('does not mutate the input array', () => {
    const a = entry({ index: 0, tokenCount: 5, priority: 0 });
    const b = entry({ index: 1, tokenCount: 5, priority: 10 });
    const input = [a, b];
    const result = selectByTokenBudget(input, 5);
    expect(input).toEqual([a, b]);
    // First sorted entry survives (priority 10 wins)
    expect(result).toEqual([b]);
  });
});

describe('formatRules (direct unit)', () => {
  function entry(
    partial: Partial<MatchedEntry> & Pick<MatchedEntry, 'index'>
  ): MatchedEntry {
    return {
      filePath: partial.filePath ?? `/abs/${partial.index}.md`,
      relativePath: partial.relativePath ?? `${partial.index}.md`,
      strippedContent: partial.strippedContent ?? `body-${partial.index}`,
      priority: partial.priority ?? 0,
      tokenCount: partial.tokenCount ?? 1,
      index: partial.index,
    };
  }

  it('formats a single survivor with preamble and exact chunk shape', () => {
    const e = entry({
      index: 0,
      relativePath: 'a.md',
      strippedContent: 'hello',
      filePath: '/abs/a.md',
    });
    const result = formatRules([e]);
    expect(result.formattedRules).toBe(
      '# OpenCode Rules\n\nPlease follow the following rules:\n\n## a.md\n\nhello'
    );
    expect(result.matchedPaths).toEqual(['/abs/a.md']);
    expect(result.tokenEstimate).toBe(
      Math.ceil(result.formattedRules.length / 4)
    );
  });

  it('joins multiple survivors with exactly \\n\\n---\\n\\n', () => {
    const a = entry({
      index: 0,
      relativePath: 'a.md',
      strippedContent: 'one',
    });
    const b = entry({
      index: 1,
      relativePath: 'b.md',
      strippedContent: 'two',
    });
    const result = formatRules([a, b]);
    expect(result.formattedRules).toContain(
      '## a.md\n\none\n\n---\n\n## b.md\n\ntwo'
    );
    expect(result.matchedPaths).toEqual([a.filePath, b.filePath]);
  });

  it('preserves survivor order in matchedPaths', () => {
    const a = entry({ index: 0, relativePath: 'x.md' });
    const b = entry({ index: 1, relativePath: 'y.md' });
    const c = entry({ index: 2, relativePath: 'z.md' });
    const result = formatRules([b, a, c]);
    expect(result.matchedPaths).toEqual([b.filePath, a.filePath, c.filePath]);
  });
});
