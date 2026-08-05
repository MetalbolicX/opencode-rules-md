---
globs: ["**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx"]
---

# TypeScript Rules

Follow these TypeScript conventions in this project.

- Use `strict` mode; never relax `strictNullChecks` or `noImplicitAny`.
- Prefer `readonly` for fields and `Readonly<T>` for collections.
- Avoid `any`; use `unknown` and narrow with type guards.
- Prefer discriminated unions over enums for state machines.
- Export types alongside the values that produce them (`export type { Foo }` next to `export const foo`).
- Use `satisfies` to assert literal types without widening.
- No `as` casts except at trust boundaries; document each with a comment.
- Error types extend `Error`; never throw plain strings or objects.

TS_RULE_MARKER
