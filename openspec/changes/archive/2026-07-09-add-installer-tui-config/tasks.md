## 1. Installer reliability
- [x] 1.1 Replace the naive main-entry guard with symlink-safe detection.
- [x] 1.2 Surface install parse/config errors instead of swallowing them.
- [x] 1.3 Add explicit output for noop and successful writes.

## 2. Config coverage
- [x] 2.1 Add TUI config path resolution and installer support for `tui.json`.
- [x] 2.2 Preserve existing entries and backups in both config files.
- [x] 2.3 Keep install idempotent and dry-run safe.

## 3. Packaging
- [x] 3.1 Move OpenTUI/Solid runtime packages to peerDependencies as host-provided TUI deps.
- [x] 3.2 Keep them in devDependencies for local development and bundling.

## 4. Verification
- [x] 4.1 Update CLI tests for `npx` execution, error handling, and TUI config writes.
- [x] 4.2 Rebuild `dist/cli.mjs`.
- [x] 4.3 Verify the `npx` install path and resulting OpenCode configs.
