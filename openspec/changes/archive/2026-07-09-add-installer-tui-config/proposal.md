## Why
The current published CLI is not reliable under `npx` because its main-entry check is symlink-fragile, and the install path does not configure the TUI side of the plugin. The package also pulls TUI runtime dependencies during `npx` execution, which causes an unnecessary npm deprecation warning. The installer needs to work cleanly while preserving the plugin's TUI feature.

## What Changes
- Make the CLI entrypoint `npx`/symlink-safe and surface install failures clearly.
- Extend the installer to register the plugin in both the OpenCode server config and the TUI config.
- Keep the TUI implementation intact, but stop installing host-provided TUI runtime packages as normal install-time dependencies.
- Preserve existing config entries, backups, idempotency, and dry-run behavior.

## Impact
- Affected specs: `package-setup`
- Affected code: `src/cli/main.ts`, `src/cli/install.ts`, `src/cli/config.ts`, `package.json`, `src/cli/*.test.ts`, `dist/cli.mjs`
- Affected runtime files: `~/.config/opencode/opencode.json`, `~/.config/opencode/tui.json`
