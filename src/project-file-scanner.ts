/**
 * Project file scanner — bounded recursive directory walk with caching.
 *
 * Scans the project directory and returns all regular file paths (as relative
 * POSIX paths) for use as `contextFilePaths` when the session has not yet
 * recorded any tool-touched paths.
 *
 * Key properties:
 * - Depth cap (default 20) prevents runaway walks
 * - Skips well-known noise dirs (.git, node_modules, dist, .opencode, etc.)
 * - Skips hidden (.prefixed) directories and symlinked dirs
 * - Module-level cache keyed by resolved projectDir, TTL 5 min
 * - Test seam: `_setProjectFilesCacheForTesting` for isolation
 *
 * @module
 */
import * as fsPromises from 'fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { createDebugLog } from './debug.js';

const debugLog = createDebugLog();

/**
 * Directories to skip during the walk.
 * Includes well-known build/cache output dirs and the rule directory itself.
 */
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.next',
  '.turbo',
  'coverage',
  '.opencode',
]);

/**
 * Options for `discoverProjectFiles`.
 */
export interface DiscoverProjectFilesOptions {
  /** Absolute path to the project root. */
  projectDir: string;
  /**
   * Maximum directory depth to descend (root = depth 0).
   * Files beyond this depth are not included.
   * @default 20
   */
  maxDepth?: number;
  /**
   * Cache time-to-live in milliseconds.
   * After this period the cache is considered stale and a re-walk occurs.
   * @default 300_000 (5 minutes)
   */
  cacheTTLMs?: number;
}

/**
 * A single cache entry for project file discovery.
 */
export interface ProjectFilesCacheEntry {
  /** Discovered relative POSIX file paths. */
  files: string[];
  /** `Date.now()` timestamp when this entry was written. */
  cachedAt: number;
}

// -----------------------------------------------------------------------------
// Module-level cache
// -----------------------------------------------------------------------------

const _cache = new Map<string, ProjectFilesCacheEntry>();

/**
 * Injected test cache — allows tests to seed the cache without filesystem
 * access.  Intended only for unit test isolation.
 *
 * @internal
 */
export function _setProjectFilesCacheForTesting(
  cache: Map<string, ProjectFilesCacheEntry>
): void {
  _cache.clear();
  for (const [key, value] of cache) {
    _cache.set(key, value);
  }
}

/**
 * Clears the module-level project-files cache.
 * Call this in `beforeEach` when testing `buildFilterContext` with an empty
 * session to prevent cross-test pollution.
 */
export function clearProjectFilesCache(): void {
  _cache.clear();
}

// -----------------------------------------------------------------------------
// Core scanner
// -----------------------------------------------------------------------------

/**
 * Discover all regular files under `projectDir` as relative POSIX paths.
 *
 * The walk is depth-bounded (default 20) and skips:
 * - Directories in `SKIP_DIR_NAMES`
 * - Any directory whose name starts with `.` (hidden)
 * - Symlinked directories (prevents loops)
 *
 * Results are cached per resolved `projectDir` for `cacheTTLMs` (default 5 min).
 *
 * Errors per-entry are swallowed (logged via `debugLog`) and the walk continues
 * with partial results.  A missing or inaccessible root returns `[]`.
 *
 * @param opts - Discovery options
 * @returns Sorted array of relative POSIX file paths
 */
export async function discoverProjectFiles(
  opts: DiscoverProjectFilesOptions
): Promise<string[]> {
  const {
    projectDir,
    maxDepth = 20,
    cacheTTLMs = 300_000,
  } = opts;

  const resolvedRoot = path.resolve(projectDir);

  // ---------------------------------------------------------------------------
  // Cache lookup
  // ---------------------------------------------------------------------------
  const cached = _cache.get(resolvedRoot);
  if (cached !== undefined && Date.now() - cached.cachedAt < cacheTTLMs) {
    return cached.files;
  }

  // ---------------------------------------------------------------------------
  // Walk
  // ---------------------------------------------------------------------------
  const files: string[] = [];

  try {
    await walkDirectory(resolvedRoot, resolvedRoot, 0, maxDepth, files);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === 'ENOENT') {
      debugLog(`discoverProjectFiles: project dir does not exist: ${resolvedRoot}`);
      return [];
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      debugLog(`discoverProjectFiles: permission denied on project dir: ${resolvedRoot}`);
      return [];
    }
    throw error;
  }

  // Sort for deterministic output
  files.sort();

  // ---------------------------------------------------------------------------
  // Cache and return
  // ---------------------------------------------------------------------------
  _cache.set(resolvedRoot, {
    files,
    cachedAt: Date.now(),
  });

  return files;
}

// -----------------------------------------------------------------------------
// Private helpers
// -----------------------------------------------------------------------------

/**
 * Recursive directory walker.
 *
 * @param dir        - Current directory being read
 * @param root      - Project root (for relative path calculation)
 * @param depth     - Current depth (root = 0)
 * @param maxDepth  - Maximum allowed depth
 * @param filesOut  - Accumulator for discovered file paths
 */
async function walkDirectory(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  filesOut: string[]
): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === 'ENOENT') {
      // Benign: directory vanished during walk
      return;
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      debugLog(`discoverProjectFiles: permission denied reading ${dir}: ${err.message}`);
      return;
    }
    // Other errors propagate
    throw error;
  }

  for (const entry of entries) {
    // Skip hidden names at the top level (files or dirs starting with '.')
    if (entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip well-known noise directory names
      if (isSkippedDir(entry.name)) {
        continue;
      }
      // Skip symlinked directories (prevents loops)
      if (entry.isSymbolicLink()) {
        continue;
      }
      // Respect depth cap
      if (depth + 1 < maxDepth) {
        await walkDirectory(fullPath, root, depth + 1, maxDepth, filesOut);
      }
    } else if (entry.isFile()) {
      // Skip symlinked regular files
      if (entry.isSymbolicLink()) {
        continue;
      }
      const relative = toPosixRelative(root, fullPath);
      filesOut.push(relative);
    }
    // Other Dirent types (BlockDevice, CharDevice, FIFO, Socket) are ignored
  }
}

/**
 * Returns `true` if the directory name is in the skip list.
 */
function isSkippedDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name);
}

/**
 * Converts an absolute path to a relative POSIX path from `root`.
 * Ensures consistent `/` separators regardless of platform.
 */
function toPosixRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  // Normalize to forward slashes (POSIX)
  return relative.split(path.sep).join('/');
}
