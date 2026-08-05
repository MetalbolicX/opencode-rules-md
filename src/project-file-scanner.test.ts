import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as fsPromises from 'fs/promises';

import { discoverProjectFiles, clearProjectFilesCache } from './project-file-scanner.js';

vi.mock('fs/promises');

const mockedFs = vi.mocked(fsPromises);

// =============================================================================
// Test Directory Management
// =============================================================================

let testDir: string;

function setupTestDir(): string {
  testDir = mkdtempSync(path.join(os.tmpdir(), 'project-file-scanner-test-'));
  return testDir;
}

function teardownTestDir(): void {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = '';
  }
}

function touch(filePath: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, '', 'utf-8');
}

// =============================================================================
// Tests
// =============================================================================

describe('discoverProjectFiles', () => {

  beforeEach(() => {
    clearProjectFilesCache();
    vi.restoreAllMocks();
    mockedFs.readdir.mockReset();
  });

  afterEach(() => {
    teardownTestDir();
  });

  // ---------------------------------------------------------------------------
  // Case A: returns relative POSIX paths under projectDir
  // ---------------------------------------------------------------------------
  it('A: returns relative POSIX paths for files under projectDir', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));
    touch(path.join(root, 'README.md'));
    touch(path.join(root, 'package.json'));

    // Build mock entry set for root + src subdir
    const srcEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: 'src' } as any;
    const readmeEntry = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'README.md' } as any;
    const pkgEntry = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'package.json' } as any;
    const indexEntry = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'index.ts' } as any;

    mockedFs.readdir
      .mockResolvedValueOnce([srcEntry, readmeEntry, pkgEntry]) // root
      .mockResolvedValueOnce([indexEntry]); // src/

    const files = await discoverProjectFiles({ projectDir: root });

    expect(files).toContain('src/index.ts');
    expect(files).toContain('README.md');
    expect(files).toContain('package.json');
    // All paths should be POSIX-style (forward slashes)
    expect(files.every((f: string) => !f.includes('\\'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Case B: skips .git, node_modules, dist, build, .cache, .next, .turbo,
  //         coverage, .opencode, and hidden (.prefixed) dirs
  // ---------------------------------------------------------------------------
  it('B: skips .git, node_modules, dist, build, .cache, .next, .turbo, coverage, .opencode, and hidden dirs', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));
    touch(path.join(root, '.git', 'HEAD'));
    touch(path.join(root, 'node_modules', 'pkg', 'index.js'));
    touch(path.join(root, 'dist', 'bundle.js'));
    touch(path.join(root, 'build', 'output.js'));
    touch(path.join(root, '.cache', 'data.json'));
    touch(path.join(root, '.next', 'cache', 'data.txt'));
    touch(path.join(root, '.turbo', 'cache', 'data.txt'));
    touch(path.join(root, 'coverage', 'report.txt'));
    touch(path.join(root, '.opencode', 'rules', 'foo.md'));
    touch(path.join(root, '.hidden-dir', 'secret.ts'));
    touch(path.join(root, '.hidden-file.txt'));

    // All dirs + src at root level
    const srcEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: 'src' } as any;
    const gitEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: '.git' } as any;
    const nmEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: 'node_modules' } as any;
    const distEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: 'dist' } as any;
    const buildEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: 'build' } as any;
    const cacheEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: '.cache' } as any;
    const nextEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: '.next' } as any;
    const turboEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: '.turbo' } as any;
    const coverageEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: 'coverage' } as any;
    const opencodeEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: '.opencode' } as any;
    const hiddenDirEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, name: '.hidden-dir' } as any;
    const hiddenFileEntry = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: '.hidden-file.txt' } as any;
    const indexEntry = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'index.ts' } as any;

    mockedFs.readdir
      .mockResolvedValueOnce([srcEntry, gitEntry, nmEntry, distEntry, buildEntry, cacheEntry, nextEntry, turboEntry, coverageEntry, opencodeEntry, hiddenDirEntry, hiddenFileEntry]) // root
      .mockResolvedValueOnce([indexEntry]); // src/

    const files = await discoverProjectFiles({ projectDir: root });

    expect(files).toContain('src/index.ts');
    expect(files).not.toContain('.git/HEAD');
    expect(files).not.toContain('node_modules/pkg/index.js');
    expect(files).not.toContain('dist/bundle.js');
    expect(files).not.toContain('build/output.js');
    expect(files).not.toContain('.cache/data.json');
    expect(files).not.toContain('.next/cache/data.txt');
    expect(files).not.toContain('.turbo/cache/data.txt');
    expect(files).not.toContain('coverage/report.txt');
    expect(files).not.toContain('.opencode/rules/foo.md');
    expect(files).not.toContain('.hidden-dir/secret.ts');
    expect(files).not.toContain('.hidden-file.txt');
  });

  // ---------------------------------------------------------------------------
  // Case C: honors depth cap 20 (create tree nested 22 levels, no file at depth > 20)
  // ---------------------------------------------------------------------------
  it('C: honors depth cap of 20 and does not descend deeper', async () => {
    const root = setupTestDir();
    // Create a chain of 22 directories: dir0/dir1/.../dir21
    const deepPath = Array.from({ length: 22 }, (_, i) => `dir${i}`).join('/');
    touch(path.join(root, deepPath, 'file.ts'));

    mockedFs.readdir.mockResolvedValue([]);

    const files = await discoverProjectFiles({ projectDir: root, maxDepth: 20 });

    // The file is at depth 22 (root=0, dir0=1, ..., dir21=22)
    // With maxDepth=20, it should NOT be included
    const deepFileIncluded = files.some((f: string) => f.includes('dir21'));
    expect(deepFileIncluded).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Case D: missing root (ENOENT) returns []
  // ---------------------------------------------------------------------------
  it('D: returns empty array when root does not exist (ENOENT)', async () => {
    mockedFs.readdir.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    );

    const files = await discoverProjectFiles({ projectDir: '/nonexistent/path/does/not/exist' });
    expect(files).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Case E: permission-denied root (EACCES) returns [] (graceful; no crash)
  // ---------------------------------------------------------------------------
  it('E: returns empty array on permission-denied root (EACCES) without crashing', async () => {
    mockedFs.readdir.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    );

    const files = await discoverProjectFiles({ projectDir: '/some/restricted/path' });
    expect(files).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Case F: cache hit — second call returns identical files without re-walk
  // ---------------------------------------------------------------------------
  it('F: cache hit — second call returns identical files without re-walking filesystem', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));
    touch(path.join(root, 'README.md'));

    mockedFs.readdir.mockResolvedValue([
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'README.md' } as any,
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'package.json' } as any,
    ]);

    // First call — populate cache
    const first = await discoverProjectFiles({ projectDir: root });
    expect(first.length).toBeGreaterThan(0);

    // Reset call count
    mockedFs.readdir.mockClear();

    // Second call should use cache
    const second = await discoverProjectFiles({ projectDir: root });
    expect(second).toEqual(first);
    expect(mockedFs.readdir).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case G: TTL expiry — re-walks after TTL
  // ---------------------------------------------------------------------------
  it('G: re-walks filesystem after cache TTL expires', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));

    // First call — populate cache
    mockedFs.readdir.mockResolvedValueOnce([
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'file.ts' } as any,
    ]);
    const first = await discoverProjectFiles({ projectDir: root, cacheTTLMs: 1 });
    expect(first.length).toBeGreaterThan(0);

    // Advance fake timers past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(2); // 2ms > 1ms TTL

    mockedFs.readdir.mockClear();
    mockedFs.readdir.mockResolvedValueOnce([
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'file.ts' } as any,
    ]);

    // Second call should re-walk due to TTL expiry
    const second = await discoverProjectFiles({ projectDir: root, cacheTTLMs: 1 });
    expect(second).toEqual(first);
    expect(mockedFs.readdir).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Case H: clearProjectFilesCache() empties the cache
  // ---------------------------------------------------------------------------
  it('H: clearProjectFilesCache() empties the cache so next call re-walks', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));

    // First call — populate cache
    mockedFs.readdir.mockResolvedValueOnce([
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'file.ts' } as any,
    ]);
    await discoverProjectFiles({ projectDir: root });

    mockedFs.readdir.mockClear();
    mockedFs.readdir.mockResolvedValueOnce([
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'file.ts' } as any,
    ]);

    // Clear cache
    clearProjectFilesCache();

    // Next call should re-walk
    const second = await discoverProjectFiles({ projectDir: root });
    expect(second.length).toBeGreaterThan(0);
    expect(mockedFs.readdir).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Additional: symlinked directories are skipped
  // ---------------------------------------------------------------------------
  it('skips symlinked directories to prevent loops', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));

    // Symlinked dir entry
    const symlinkEntry = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => true, name: 'symlink-dir' } as any;

    mockedFs.readdir.mockResolvedValue([symlinkEntry]);

    const files = await discoverProjectFiles({ projectDir: root });

    // Should not recurse into symlinked dir
    expect(files).not.toContain('symlink-dir/index.ts');
    expect(mockedFs.readdir).toHaveBeenCalledTimes(1); // Only root readdir
  });

  // ---------------------------------------------------------------------------
  // Additional: only regular files are returned (not symlinked files)
  // ---------------------------------------------------------------------------
  it('returns only regular files, not symlinked files', async () => {
    const root = setupTestDir();
    touch(path.join(root, 'src', 'index.ts'));

    // Real file + symlinked file
    mockedFs.readdir.mockResolvedValue([
      { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: 'real.txt' } as any,
      { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true, name: 'symlink.txt' } as any,
    ]);

    const files = await discoverProjectFiles({ projectDir: root });

    expect(files).toContain('real.txt');
    expect(files).not.toContain('symlink.txt');
  });

});
