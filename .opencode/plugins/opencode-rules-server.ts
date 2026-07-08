// .opencode/plugins/opencode-rules-server.ts
// Workspace-local server plugin loader. Re-exports the compiled server entry
// from this repo's dist/ output. OpenCode auto-discovers this file from
// .opencode/plugins/ — no explicit opencode.json listing required.
export { default } from '../../dist/src/index.js';