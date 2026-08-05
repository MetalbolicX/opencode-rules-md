---
globs: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"]
---

# JavaScript Rules

Follow these JavaScript conventions when editing JS files.

- Prefer ES modules (`import`/`export`); use `.mjs` for explicit ESM.
- Use `const` by default; `let` only when reassignment is needed; never `var`.
- Prefer pure functions and immutability; avoid mutating function arguments.
- Use optional chaining (`?.`) and nullish coalescing (`??`) over `&&` / `||` chains.
- Destructure props and function arguments for readability.
- Use `async`/`await` over raw promise chains.
- Always handle promise rejections explicitly; no floating promises.
- Add JSDoc to exported functions for tooling support.
- Use `===` / `!==`; never `==` / `!=`.

JS_RULE_MARKER
