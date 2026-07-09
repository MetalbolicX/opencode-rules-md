## 1. Installer reliability
- [ ] 1.1 Replace the naive main-entry guard with symlink-safe detection.
- [ ] 1.2 Surface install parse/config errors instead of swallowing them.
- [ ] 1.3 Add explicit output for noop and successful writes.

## 2. Config coverage
- [ ] 2.1 Add TUI config path resolution and installer support for `tui.json`.
- [ ] 2.2 Preserve existing entries and backups in both config files.
- [ ] 2.3 Keep install idempotent and dry-run safe.

## 3. Packaging
- [ ] 3.1 Move OpenTUI/Solid runtime packages to peerDependencies as host-provided TUI deps.
- [ ] 3.2 Keep them in devDependencies for local development and bundling.

## 4. Verification
- [ ] 4.1 Update CLI tests for `npx` execution, error handling, and TUI config writes.
- [ ] 4.2 Rebuild `dist/cli.mjs`.
- [ ] 4.3 Verify the `npx` install path and resulting OpenCode configs.
