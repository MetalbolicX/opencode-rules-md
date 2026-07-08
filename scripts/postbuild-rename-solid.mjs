/**
 * scripts/postbuild-rename-solid.mjs
 *
 * Postbuild script that normalizes Solid helper prefixes AND fixes the
 * solid-js/web shim issues in the bundled output.
 *
 * Problems fixed:
 * 1. setStyleProperty not exported from solid-js/web server build
 * 2. template() throws in Node.js at module initialization
 *
 * Safe to run unconditionally after every build.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BUNDLE_PATH = resolve(process.argv[2] ?? 'dist/tui.js');

let content;
try {
  content = readFileSync(BUNDLE_PATH, 'utf-8');
} catch {
  // Bundle doesn't exist yet — nothing to normalize
  process.exit(0);
}

// ── Solid helper shims ────────────────────────────────────────────────────────
// solid-js/web server build is missing helpers that babel-preset-solid generates.
// We filter them from imports and inject inline shims.
// Shim names use a unique suffix to avoid identifier collisions.
const SOLID_SETSTYLEPROP_SHIM = '__solid_setStyleProp_shim_12345__';
const SOLID_TEMPLATE_SHIM = '__solid_template_shim_67890__';
const SOLID_DELEGATEEVENTS_SHIM = '__solid_delegateEvents_shim_98765__';

const shimCode = `
// INLINE SHIM: setStyleProperty not in solid-js/web server build
const ${SOLID_SETSTYLEPROP_SHIM} = (el, prop, value) => {
  try { if (el && el.setAttribute) el.setAttribute(prop, value); } catch(e) {}
};
// INLINE SHIM: template() throws in Node.js at module init
const ${SOLID_TEMPLATE_SHIM} = (strings, ..._values) => ({ values: [], strings });
// INLINE SHIM: delegateEvents is client-only DOM event delegation - N/A in TUI
const ${SOLID_DELEGATEEVENTS_SHIM} = (_events) => {};
`;

// Items to remove from solid-js/web imports and replace with shims
// setStyleProperty: not exported from server build
// template: throws in Node.js at module init
// delegateEvents: throws client-only API in Node.js (event delegation - N/A in TUI)
const SHIMMED = ['setStyleProperty', 'template', 'delegateEvents'];

// Normalize all solid-js/web imports: remove shimmed items, inject shim once
let shimInjected = false;
content = content.replace(
  /import \{([^}]*)\} from "solid-js\/web";?/g,
  (fullMatch, importsStr) => {
    const items = importsStr.split(',').map(s => s.trim());
    const filtered = items.filter(item => !SHIMMED.some(s => item.includes(s)));
    if (!shimInjected) {
      shimInjected = true;
      if (filtered.length === 0) {
        return `import "solid-js/web";\n${shimCode}`;
      }
      return `import { ${filtered.join(', ')} } from "solid-js/web";\n${shimCode}`;
    }
    if (filtered.length === 0) {
      return `import "solid-js/web";`;
    }
    return `import { ${filtered.join(', ')} } from "solid-js/web";`;
  }
);

// Replace mangled helper calls with shims
content = content.replace(/_\$setStyleProperty\(/g, `${SOLID_SETSTYLEPROP_SHIM}(`);
content = content.replace(/_\$template\(/g, `${SOLID_TEMPLATE_SHIM}(`);
content = content.replace(/_\$delegateEvents\(/g, `${SOLID_DELEGATEEVENTS_SHIM}(`);

// ── Normalize Solid helper prefixes ──────────────────────────────────────────
// Guard: only rewrite when known-bad patterns are present
const HAS_BAD_PREFIX = content.includes('SolidJS$');
if (HAS_BAD_PREFIX) {
  content = content.replace(/\bSolidJS[$](create|run|owner)\b/g, (_, name) => name);
}

writeFileSync(BUNDLE_PATH, content, 'utf-8');
console.log(`[postbuild] Normalized Solid helpers in ${BUNDLE_PATH}`);
