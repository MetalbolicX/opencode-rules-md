// .opencode/plugins/opencode-rules-tui.ts
// Workspace-local TUI plugin loader. Re-exports the compiled TUI entry
// from this repo's dist/ output. OpenCode auto-discovers this file from
// .opencode/plugins/ — no explicit tui.json listing required.
export { default } from '../../dist/tui/index.js';