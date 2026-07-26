# config-management Specification

## Purpose

This specification defines how the opencode-rules-md plugin manages configuration file parsing, path resolution, plugin configuration, and atomic write operations for config files.

## Requirements

### Requirement: JSONC Config Parsing

The `config-parser.ts` module MUST export a single function `parseJsonc(content: string): Record<string, unknown>` that strips `//` line comments and `/* */` block comments from a JSONC string and returns the parsed JSON object. Comment stripping MUST respect string boundaries so that `//` or `/*` sequences appearing inside double-quoted or single-quoted string literals are preserved verbatim. String-boundary tracking MUST be owned by a private helper named `isInsideString`. The function MUST throw when the comment-stripped result is malformed JSON.

#### Scenario: Parses JSON without comments

- **GIVEN** a content string `{"name": "opencode"}` with no comments
- **WHEN** `parseJsonc(content)` is called
- **THEN** the result SHALL equal `{ name: "opencode" }`

#### Scenario: Strips line comments outside strings

- **GIVEN** a content string with a `// trailing comment` after a value
- **WHEN** `parseJsonc(content)` is called
- **THEN** the `//` comment and everything after it on that line SHALL be removed
- **AND** the remaining JSON SHALL parse successfully

#### Scenario: Strips block comments outside strings

- **GIVEN** a content string containing `/* a block comment */` between tokens
- **WHEN** `parseJsonc(content)` is called
- **THEN** the block comment SHALL be removed
- **AND** the surrounding JSON SHALL parse successfully

#### Scenario: Preserves comment-like sequences inside double-quoted strings

- **GIVEN** a content string containing a value `"http://example.com"` and `"a /* b */ c"`
- **WHEN** `parseJsonc(content)` is called
- **THEN** the `//` and `/* */` sequences inside the double-quoted strings SHALL be preserved verbatim in the parsed value

#### Scenario: Preserves comment-like sequences inside single-quoted strings

- **GIVEN** a content string containing a single-quoted value `'http://example.com'`
- **WHEN** `parseJsonc(content)` is called
- **THEN** the `//` sequence inside the single-quoted string SHALL be preserved verbatim in the parsed value

#### Scenario: Throws on malformed JSON after stripping

- **GIVEN** a content string `{ "key": , }` that is invalid even after comment stripping
- **WHEN** `parseJsonc(content)` is called
- **THEN** the call SHALL throw a parsing error

### Requirement: Config Path Resolution

The `config-resolver.ts` module MUST export a single function `resolveConfigPath(fs, env, basename)` returning `{ path: string; exists: boolean }`. Resolution of the config directory MUST be owned by a private helper named `resolveConfigDir` that honors the `OPENCODE_CONFIG_DIR` environment variable first, then the `XDG_CONFIG_HOME` environment variable as a fallback. The returned object MUST report whether the resolved file currently exists without throwing when the file is absent.

#### Scenario: Resolves to OPENCODE_CONFIG_DIR when env var is set

- **GIVEN** `env.OPENCODE_CONFIG_DIR` is set to `/custom/config`
- **AND** `basename` is `"opencode"`
- **WHEN** `resolveConfigPath(fs, env, "opencode")` is called
- **THEN** the resolved `path` SHALL be `/custom/config/opencode.json`

#### Scenario: Falls back to XDG_CONFIG_HOME when OPENCODE_CONFIG_DIR is unset

- **GIVEN** `env.OPENCODE_CONFIG_DIR` is unset or empty
- **AND** `env.XDG_CONFIG_HOME` is set to `/home/user/.config`
- **AND** `basename` is `"opencode"`
- **WHEN** `resolveConfigPath(fs, env, "opencode")` is called
- **THEN** the resolved `path` SHALL be `/home/user/.config/opencode/opencode.json`

#### Scenario: Reports exists false when the file is absent

- **GIVEN** the resolved config path points to a file that does not exist on disk
- **WHEN** `resolveConfigPath(fs, env, basename)` is called
- **THEN** the returned `exists` SHALL be `false`
- **AND** the call SHALL NOT throw

#### Scenario: Reports exists true when the file is present

- **GIVEN** the resolved config path points to a file that exists on disk
- **WHEN** `resolveConfigPath(fs, env, basename)` is called
- **THEN** the returned `exists` SHALL be `true`

### Requirement: Plugin Config Matching

The `plugin-config.ts` module MUST export `normalizePlugin`, `readInstalledPlugins`, `matchesPlugin`, `findInstalledPlugin`, `dedupePlugins`, and `buildSpecifier`. Plugin name matching MUST treat the plugin name as a literal pattern (escaping regex metacharacters via a private helper named `escapeRegex`) and MUST allow an optional `@version` suffix. Entry validation MUST reject non-string entries rather than throwing unhandled.

#### Scenario: matchesPlugin returns true for exact name match

- **GIVEN** an installed entry `"opencode-rules-md"` and a target name `"opencode-rules-md"`
- **WHEN** `matchesPlugin(entry, "opencode-rules-md")` is called
- **THEN** the result SHALL be `true`

#### Scenario: matchesPlugin returns true for name@version pattern

- **GIVEN** an installed entry `"opencode-rules-md@1.2.3"` and a target name `"opencode-rules-md"`
- **WHEN** `matchesPlugin(entry, "opencode-rules-md")` is called
- **THEN** the result SHALL be `true` because the `@version` suffix is optional

#### Scenario: matchesPlugin rejects non-string entries

- **GIVEN** an installed entry that is not a string (e.g. `42` or `null`)
- **WHEN** `matchesPlugin(entry, "opencode-rules-md")` is called
- **THEN** the result SHALL be `false`
- **AND** the call SHALL NOT throw

#### Scenario: findInstalledPlugin returns first matching specifier or undefined

- **GIVEN** an installed plugin list `["other-plugin", "opencode-rules-md@1.0.0"]`
- **WHEN** `findInstalledPlugin(list, "opencode-rules-md")` is called
- **THEN** the result SHALL be `"opencode-rules-md@1.0.0"`
- **AND** when no entry matches, the result SHALL be `undefined`

#### Scenario: readInstalledPlugins prefers modern plugin field over legacy plugins field

- **GIVEN** a parsed config object containing both a modern `plugin` field and a legacy `plugins` field
- **WHEN** `readInstalledPlugins(config)` is called
- **THEN** the modern `plugin` field SHALL be read first
- **AND** the legacy `plugins` field SHALL be used only as a fallback when `plugin` is absent

#### Scenario: dedupePlugins keeps most recent non-omd entry and removes duplicates

- **GIVEN** a plugin list containing duplicate entries where the most recent non-`omd` entry differs from an earlier one
- **WHEN** `dedupePlugins(list)` is called
- **THEN** duplicates SHALL be collapsed to a single entry
- **AND** the most recent non-`omd` entry SHALL be the one retained

### Requirement: Backup Rotation and Atomic Writes

The `config-writer.ts` module MUST export `backupIfWritable`, `rotateBackups`, and `writeAtomically`. A private helper named `timestamp` MUST produce a stable timestamp suffix used in backup filenames. A constant `BACKUP_LIMIT` (default value `3`) MUST bound the maximum number of retained backups. Atomic writes MUST write to a temporary file first and then rename it over the target so that readers never observe a partially written file.

#### Scenario: rotateBackups keeps at most BACKUP_LIMIT newest backups

- **GIVEN** a directory containing fewer than `BACKUP_LIMIT` existing backups
- **WHEN** `rotateBackups` runs after a new backup is created
- **THEN** the total number of retained backups SHALL NOT exceed `BACKUP_LIMIT`

#### Scenario: rotateBackups deletes oldest backups when limit is exceeded

- **GIVEN** a directory containing more than `BACKUP_LIMIT` existing backups after a new backup is added
- **WHEN** `rotateBackups` runs
- **THEN** the oldest backups SHALL be deleted until only the `BACKUP_LIMIT` newest remain

#### Scenario: writeAtomically writes to a temp file then renames over the target

- **GIVEN** a target path and file content to write
- **WHEN** `writeAtomically(target, content)` is called
- **THEN** the content SHALL first be written to a temporary file
- **AND** the temporary file SHALL then be renamed over the target path
- **AND** no partial content SHALL ever be observable at the target path

#### Scenario: writeAtomically cleans up the temp file on failure

- **GIVEN** a `writeAtomically` operation that fails after the temp file is created (e.g. rename fails)
- **WHEN** the failure occurs
- **THEN** the temporary file SHALL be removed
- **AND** the original target file SHALL remain unchanged

#### Scenario: backupIfWritable skips backup when target is not writable

- **GIVEN** a target file that is not writable (e.g. on a read-only mount or a directory the process cannot write to)
- **WHEN** `backupIfWritable` is called
- **THEN** the operation SHALL skip creating a backup
- **AND** the call SHALL NOT throw

### Requirement: Composition Root and Facade Contract

The `src/cli/config.ts` module MUST act as the composition root and thin facade. It MUST own `loadGlobalConfig` and the `GlobalConfig` / `LoadedConfig` types, delegating file discovery to `resolveConfigPath` and parsing to `parseJsonc`. It MUST re-export every previously-exported symbol from `config-parser.ts`, `config-resolver.ts`, `plugin-config.ts`, and `config-writer.ts` so that all existing `./config.js` imports — including `src/cli/status.ts`, `src/cli/install.ts`, `src/cli/uninstall.ts`, `src/cli/update.ts`, `src/cli/main.ts`, `src/cli/real-fs.ts`, and `src/cli/config.test.ts` — continue to resolve without modification.

#### Scenario: All previously exported symbols are re-exported from the facade

- **GIVEN** the four focused modules export `parseJsonc`, `resolveConfigPath`, `normalizePlugin`, `readInstalledPlugins`, `matchesPlugin`, `findInstalledPlugin`, `dedupePlugins`, `buildSpecifier`, `backupIfWritable`, `rotateBackups`, and `writeAtomically`
- **WHEN** an importer does `import { ... } from "./config.js"`
- **THEN** every one of those symbols SHALL be resolvable from the facade
- **AND** no importer SHALL require a path change

#### Scenario: loadGlobalConfig delegates to resolveConfigPath and parseJsonc

- **GIVEN** a config file exists at the resolved path
- **WHEN** `loadGlobalConfig()` is called
- **THEN** it SHALL use `resolveConfigPath` to locate the file
- **AND** it SHALL use `parseJsonc` to parse the contents
- **AND** the returned `LoadedConfig` SHALL expose `{ path, exists, data }`

#### Scenario: loadGlobalConfig throws a clear error when the file is malformed JSON

- **GIVEN** the resolved config file exists but contains malformed JSON that `parseJsonc` cannot parse
- **WHEN** `loadGlobalConfig()` is called
- **THEN** the call SHALL throw an error that identifies the file and the parse failure

#### Scenario: Cross-cutting constants and the CliFs interface are re-exported from the facade

- **GIVEN** the focused modules own `PLUGIN_NAME`, `BACKUP_LIMIT`, `OPENCODE_CONFIG_SUBDIR`, and the `CliFs` interface
- **WHEN** an importer references any of these via `./config.js`
- **THEN** each SHALL be re-exported from the facade and continue to resolve

### Requirement: Public API Stability

The module split MUST be non-breaking for every existing consumer. The six production importers (`src/cli/status.ts`, `src/cli/install.ts`, `src/cli/uninstall.ts`, `src/cli/update.ts`, `src/cli/main.ts`, and `src/cli/real-fs.ts`) and `src/cli/config.test.ts` MUST require no source changes. The existing test suite MUST pass without modification, serving as the acceptance signal that the facade contract is satisfied.

#### Scenario: pnpm test:run passes with config.test.ts unmodified

- **GIVEN** the four focused modules and the facade are in place
- **AND** `src/cli/config.test.ts` is left byte-for-byte unchanged
- **WHEN** `pnpm test:run` is executed
- **THEN** all tests in `config.test.ts` SHALL pass

#### Scenario: tsc --noEmit passes with all importer modules unmodified

- **GIVEN** the four focused modules and the facade are in place
- **AND** none of the six production importer modules are modified
- **WHEN** `pnpm exec tsc --noEmit` is executed
- **THEN** the type check SHALL succeed with no errors
