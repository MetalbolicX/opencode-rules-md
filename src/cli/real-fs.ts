// ---------------------------------------------------------------------------
// src/cli/real-fs.ts — Default `CliFs` adapter backed by `node:fs`.
//
// The CLI commands default to the real filesystem in production. Tests inject
// an in-memory adapter to keep everything deterministic and fast. All methods
// are sync — the CLI is short-lived and never benefits from async I/O.
// ---------------------------------------------------------------------------

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { CliFs } from "./config";

export const createRealFs = (): CliFs => ({
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync: (path, content) => {
    writeFileSync(path, content);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  copyFileSync: (from, to) => {
    copyFileSync(from, to);
  },
  unlinkSync: (path) => {
    unlinkSync(path);
  },
  mkdirSync: (path, opts) => {
    mkdirSync(path, opts);
  },
  readdirSync: (path) => readdirSync(path),
  existsSync: (path) => existsSync(path),
  rmdirSync: (path) => {
    rmdirSync(path);
  },
});
