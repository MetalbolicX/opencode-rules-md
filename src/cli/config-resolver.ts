/**
 * src/cli/config-resolver.ts
 *
 * Config directory and path resolution.
 * Exports: OPENCODE_CONFIG_SUBDIR, CliFs, resolveConfigPath
 */

import { join } from 'path';
import { homedir } from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const OPENCODE_CONFIG_SUBDIR = 'opencode';

// ─────────────────────────────────────────────────────────────────────────────
// CliFs interface
// ─────────────────────────────────────────────────────────────────────────────

export interface CliFs {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  rmdirSync(path: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveConfigDir / resolveConfigPath
// ─────────────────────────────────────────────────────────────────────────────

function resolveConfigDir(env: NodeJS.ProcessEnv): string {
  const custom = env.OPENCODE_CONFIG_DIR;
  if (custom && custom.trim() !== '') {
    return custom;
  }

  // Honor the XDG Base Directory Specification when it is set.
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') {
    return join(xdg, OPENCODE_CONFIG_SUBDIR);
  }

  // Fall back to $HOME/.config/opencode before using os.homedir().
  // This keeps tests that control HOME deterministic and avoids loading the
  // wrong global config when the process environment is customized.
  const home = env.HOME;
  if (home && home.trim() !== '') {
    return join(home, '.config', OPENCODE_CONFIG_SUBDIR);
  }

  return join(homedir(), '.config', OPENCODE_CONFIG_SUBDIR);
}

/**
 * Resolve the config path for a given basename.
 * Prefers .json over .jsonc; returns { path, exists }.
 * The path does NOT need to exist — absent configs are valid for first install.
 */
export function resolveConfigPath(
  fs: CliFs,
  env: NodeJS.ProcessEnv,
  basename: string = 'opencode'
): { path: string; exists: boolean } {
  const dir = resolveConfigDir(env);
  const jsonPath = join(dir, basename + '.json');
  const jsoncPath = join(dir, basename + '.jsonc');

  if (fs.existsSync(jsonPath)) {
    return { path: jsonPath, exists: true };
  }
  if (fs.existsSync(jsoncPath)) {
    return { path: jsoncPath, exists: true };
  }

  return { path: jsonPath, exists: false };
}
