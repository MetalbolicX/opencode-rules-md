/**
 * Thin synchronous adapter over node:fs that implements the CliFs interface.
 * All production CLI disk I/O flows through this module — no direct node:fs
 * calls outside this file.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Synchronous filesystem interface used by the CLI.
 * Tests supply an in-memory implementation; production uses this adapter.
 */
export interface CliFs {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string, encoding?: string): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}

/**
 * Production CliFs implementation backed by node:fs (synchronous).
 */
export const realFs: CliFs = {
  readFileSync(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  },

  writeFileSync(filePath: string, content: string, _encoding?: string): void {
    // Ensure parent directory exists before writing
    const dir = nodePath.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  },

  renameSync(from: string, to: string): void {
    fs.renameSync(from, to);
  },

  copyFileSync(from: string, to: string): void {
    fs.copyFileSync(from, to);
  },

  unlinkSync(filePath: string): void {
    fs.unlinkSync(filePath);
  },

  mkdirSync(filePath: string, opts?: { recursive?: boolean }): void {
    fs.mkdirSync(filePath, opts);
  },

  readdirSync(filePath: string): string[] {
    return fs.readdirSync(filePath);
  },

  existsSync(filePath: string): boolean {
    return fs.existsSync(filePath);
  },
};
