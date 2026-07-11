/**
 * scripts/build-tui.mjs
 *
 * Bundles tui/index.tsx with Bun.build + @opentui/solid/bun-plugin
 * to produce dist/tui/index.js with Solid's reactive JSX transform.
 *
 * This script runs AFTER `tsc` in the `build` pipeline so that
 * dist/tui/index.d.ts (from tsc) is preserved for TypeScript consumers
 * while only the runtime JS bundle is re-produced by Bun.
 */
import { build } from 'bun';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

/** @type {import('bun').BunPlugin} */
import solidPlugin from '@opentui/solid/bun-plugin';

const entry = resolve(rootDir, 'tui/index.tsx');
// Write into `dist/` so Bun preserves the entry's `tui/` prefix and emits
// `dist/tui/index.js`. Writing directly into `dist/tui/` would make Bun
// nest the entry under it and produce `dist/tui/tui/index.js`, which
// `tui.json` does not reference and which `tsc` would never overwrite.
const outdir = resolve(rootDir, 'dist');

/**
 * Peer runtime modules that should NOT be bundled — they are provided
 * by the host OpenCode environment at runtime.
 */
const EXTERNALS = [
  '@opencode-ai/plugin/tui',
  '@opencode-ai/plugin',
  '@opencode-ai/sdk',
  'solid-js',
  '@opentui/solid',
  '@opentui/core',
  // CJS deps that Bun wraps in `__require`. Leave them external so Node ESM
  // can also load the bundle when OpenCode's plugin runtime uses Node.
  'yaml',
  'minimatch',
];

console.log('[build-tui] Building TUI bundle with Bun + Solid transform...');

const result = await build({
  entrypoints: [entry],
  outdir,
  root: rootDir,
  target: 'bun',
  format: 'esm',
  plugins: [solidPlugin],
  external: EXTERNALS,
  // throws: true is the default when a plugin is present, but be explicit
  // so bundle errors fail the process hard.
  // @ts-ignore — throwOnError is valid Bun.BuildOptions
  throwOnError: true,
  // Sourcemap for debugging
  sourcemap: 'linked',
  // Do not minify — preserve readability of the bundle for now
  minify: false,
});

if (!result.success) {
  console.error('[build-tui] Bundle failed:');
  for (const msg of result.logs) {
    console.error(`  ${msg.message}`);
  }
  process.exit(1);
}

console.log('[build-tui] Bundle emitted to dist/tui/index.js');
console.log('[build-tui] Build complete.');

// Post-build assertion: ensure the emitted bundle is the reactive Solid output
// and not the non-reactive tsc artifact. If Bun's outdir behavior changes in
// the future (e.g. nesting `tui/` under `dist/tui/`), this guard will fail
// loudly instead of silently shipping a broken plugin.
import { readFileSync } from 'fs';
const emittedPath = resolve(rootDir, 'dist/tui/index.js');
const emitted = readFileSync(emittedPath, 'utf-8');
if (/jsx-runtime/.test(emitted)) {
  console.error(
    `[build-tui] FATAL: dist/tui/index.js still contains a jsx-runtime import.\n` +
      `The Solid reactive transform did NOT overwrite the tsc output.\n` +
      `Check that scripts/build-tui.mjs outdir emits to dist/tui/index.js.`
  );
  process.exit(1);
}
if (!/createSignal|createEffect|createMemo/.test(emitted)) {
  console.error(
    `[build-tui] FATAL: dist/tui/index.js has no Solid reactive constructs.\n` +
      `The bundle may be empty or the Solid plugin did not run.`
  );
  process.exit(1);
}
