## Context
The installer currently only updates the server-side OpenCode config and relies on a fragile executable guard in the bundled CLI. The package also ships TUI runtime dependencies in `dependencies`, which forces `npx` to download them even though OpenCode already provides them in its global config install tree.

## Goals / Non-Goals
- Goals:
  - Make `npx opencode-rules-md install` execute reliably.
  - Register the plugin in both `opencode.json` and `tui.json`.
  - Keep the TUI feature and its source intact.
  - Avoid pulling TUI runtime packages into the installer download path.
- Non-Goals:
  - Redesigning the TUI UI.
  - Changing the plugin's runtime rule discovery behavior.
  - Introducing a new installer framework.

## Decisions
- Use a symlink-safe main guard based on `realpathSync` plus `pathToFileURL` so the bundled CLI runs under `npx` wrappers.
- Make install failures explicit: malformed config should stop the write and print a useful error instead of silently returning a non-actionable status.
- Treat OpenTUI and Solid packages as host-provided peer dependencies so the plugin's TUI remains available without forcing `npx` to download them.
- Keep `minimatch` and `yaml` as runtime dependencies because the server runtime uses them directly.
- Reuse the same backup and atomic-write helpers for both OpenCode config files so the behavior stays consistent.

## Risks / Trade-offs
- If OpenCode does not resolve peer dependencies for the TUI from its host install tree, the TUI sidebar could fail to load.
- Supporting two config files adds a second write path, so install needs careful error handling to avoid a partial update.
- Refusing to overwrite malformed configs is safer, but it means the installer will fail fast instead of attempting a repair.

## Migration Plan
- Preserve existing `opencode.json` and `tui.json` contents.
- Append the plugin to each config only when missing.
- Write backups before each file update.
- Verify the plugin still loads in OpenCode after the packaging changes.
