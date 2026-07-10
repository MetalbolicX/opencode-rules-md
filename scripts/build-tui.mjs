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
const outdir = resolve(rootDir, 'dist/tui');

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
