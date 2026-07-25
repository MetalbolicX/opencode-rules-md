/**
 * src/cli/config-parser.ts
 *
 * JSONC (JSON with Comments) parsing.
 * Exports: parseJsonc
 */

// ─────────────────────────────────────────────────────────────────────────────
// parseJsonc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse JSONC (JSON with Comments) content.
 * Strips single-line and multi-line comments and trailing commas.
 * Returns an empty object for empty/whitespace-only input.
 * Throws if the stripped content is not valid JSON.
 */
export function parseJsonc(content: string): Record<string, unknown> {
  if (content.trim() === '') {
    return {};
  }

  // String-aware comment stripping with bracket-depth tracking.
  let out = '';
  let i = 0;
  // Bracket depth outside strings: +1 for {, -1 for }, +1 for [, -1 for ].
  let depth = 0;

  while (i < content.length) {
    const ch = content[i]!;

    // Start of // comment — strip until newline or end-of-string.
    if (ch === '/' && content[i + 1] === '/' && !isInsideString(out)) {
      let j = i + 2;
      while (j < content.length && content[j] !== '\n') {
        j++;
      }
      out += ' '; // replace the comment with a single space
      // If we stopped at a newline (not EOF): skip the newline — it is the
      // comment terminator, not JSON content. Set i to j so the outer loop
      // increments past the newline without adding it.
      if (j < content.length && content[j] === '\n') {
        i = j; // outer i++ lands on j (the newline), then increments to j+1
        continue;
      }
      // EOF (j >= content.length): the comment runs to end of file.
      // Preserve a trailing } or ] at EOF as it is likely the JSON closer.
      if (j >= content.length) {
        const last = content[content.length - 1]!;
        if (last === '}' || last === ']') {
          out += last;
        }
        i = j;
      } else {
        i = j - 1; // outer i++ will land on j (EOF terminator position)
      }
      continue;
    }

    // Start of /* */ comment — strip the whole span
    if (ch === '/' && content[i + 1] === '*' && !isInsideString(out)) {
      let j = i + 2;
      while (j < content.length - 1) {
        if (content[j] === '*' && content[j + 1] === '/') {
          j += 2;
          break;
        }
        j++;
      }
      out += ' ';
      i = j;
      continue;
    }

    // Track bracket depth (outside strings)
    if (!isInsideString(out)) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
    }

    out += ch;
    i++;
  }

  // Phase 2a: strip trailing commas before ] or }
  let s = out.replace(/,(\s*[}\]])/g, '$1');

  // Phase 2b: if at root level (depth > 0 means a } was consumed as comment text
  // at EOF) and s has no closing } or ], add it and strip any trailing comma.
  if (depth > 0 && !/[}\]]/.test(s)) {
    s = s.replace(/,(\s*$)/, '') + '}';
    depth = 0; // we repaired it
  }

  if (s.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(
      'parseJsonc: invalid JSON after stripping comments - ' + msg
    );
  }
}

/** True if the number of unescaped double or single quotes in `s` is odd. */
function isInsideString(s: string): boolean {
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!inStr && (ch === '"' || ch === "'")) {
      inStr = true;
      strChar = ch;
    } else if (inStr && ch === '\\') {
      i++; // skip escaped char
    } else if (inStr && ch === strChar) {
      inStr = false;
      strChar = '';
    }
  }
  return inStr;
}
