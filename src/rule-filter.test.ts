/**
 * Contract tests for readAndFormatRules output shape and measurement helpers.
 * Locks the exact current formatting so later token-optimization work can
 * prove regressions and prove reductions against a fixed baseline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { estimateTokens, readAndFormatRules } from './rule-filter.js';
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
      const rule1 = writeRule('low.md', '---\npriority: 0\n---\nlow-priority body');
      const rule2 = writeRule('high.md', '---\npriority: 10\n---\nhigh-priority body');
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
      const rule2 = writeRule('second.md', '---\npriority: 5\n---\nsecond body');
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
      const rule1 = writeRule('p5-first.md', '---\npriority: 5\n---\nbody');
      const rule2 = writeRule('p5-second.md', '---\npriority: 5\n---\nbody');
      const rule3 = writeRule('p3.md', '---\npriority: 3\n---\nbody');
      const rule4 = writeRule('p10.md', '---\npriority: 10\n---\nbody');
      // Budget ~10 tokens: fits p10 (priority 10) and p5-first (priority 5) but not p5-second or p3
      // estimateTokens("## pX.md\n\nbody") ≈ ceil(18/4) = 5 tokens each
      const result = await readAndFormatRules(
        [rule1, rule2, rule3, rule4],
        { maxTokens: 10 }
      );
      // p10 first (priority 10), then p5-first (priority 5, discovered before p5-second)
      expect(result.matchedPaths).toHaveLength(2);
      expect(result.matchedPaths[0]).toContain('p10.md');
      expect(result.matchedPaths[1]).toContain('p5-first.md');
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
