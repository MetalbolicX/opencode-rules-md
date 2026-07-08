import { defineConfig } from 'tsup';
import { parse } from 'node:path';
import { readFile } from 'node:fs/promises';
import { transformAsync } from '@babel/core';
import solid from 'babel-preset-solid';
import ts from '@babel/preset-typescript';

/**
 * Custom esbuild plugin that runs babel-preset-solid on .tsx files.
 * The solid-js/web shim fixup (setStyleProperty, template, delegateEvents)
 * is handled by the postbuild script, not here.
 */
function solidPlugin() {
  return {
    name: 'solid-jsx',
    setup(build) {
      build.onLoad({ filter: /\.(t|j)sx$/ }, async (args) => {
        const source = await readFile(args.path, { encoding: 'utf-8' });
        const { name, ext } = parse(args.path);
        const filename = name + ext;

        const result = await transformAsync(source, {
          presets: [
            [solid, {}],
            [ts, {}],
          ],
          filename,
          sourceMaps: false,
        });

        if (!result?.code) {
          throw new Error(`Babel transform returned nothing for ${args.path}`);
        }

        return { contents: result.code, loader: 'js' };
      });
    },
  };
}

export default defineConfig({
  entry: { 'tui': 'tui/index.tsx' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  splitting: false,
  sourcemap: true,
  clean: false,
  esbuildPlugins: [solidPlugin()],
  dts: { entry: { tui: 'tui/index.tsx' } },
  external: [],
  noExternal: ['@opentui/core', '@opentui/solid'],
});
