# General Project Rules

These rules apply to every file in the project, regardless of type.

- Match the existing code style; do not reformat unrelated code.
- Prefer small, focused commits with conventional commit messages.
- Write tests for any non-trivial behavior change; follow the project's test patterns.
- Document public APIs in the file they are declared (JSDoc / TSDoc).
- Keep dependencies justified; add a one-line reason in commit messages for new ones.
- Never commit secrets, credentials, or `.env` files.
- Use the project's logger (`src/log.ts`); never `console.log` in production code.

GENERAL_RULE_MARKER
