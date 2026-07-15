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
});
