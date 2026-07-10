# package-setup Specification

## Purpose
TBD - created by archiving change setup-typescript-package. Update Purpose after archive.
## Requirements
### Requirement: TypeScript Package Configuration

The project SHALL be configured as a TypeScript package with proper build tooling, OpenCode dependencies, and strict type safety. Hook handlers SHALL use properly typed interfaces matching the `@opencode-ai/plugin` API.

#### Scenario: Package initialization

- **WHEN** the repository is set up
- **THEN** package.json SHALL exist with TypeScript configuration
- **AND** @opencode-ai/sdk and @opencode-ai/plugin SHALL be listed as dependencies
- **AND** build scripts SHALL be configured for TypeScript compilation

#### Scenario: Development workflow

- **WHEN** a developer runs bun install
- **THEN** all dependencies SHALL be installed successfully
- **AND** TypeScript SHALL be configured for the project
- **AND** the package SHALL be importable as "opencode-rules-md"

#### Scenario: Build process

- **WHEN** build scripts are executed
- **THEN** TypeScript source SHALL compile to JavaScript
- **AND** output SHALL be generated in dist/ directory
- **AND** package exports SHALL be properly configured

#### Scenario: Code formatting

- **WHEN** Prettier is run on source files
- **THEN** code SHALL be formatted according to project conventions
- **AND** consistent style SHALL be applied across all TypeScript files

#### Scenario: Unit testing setup

- **WHEN** Vitest is executed
- **THEN** test framework SHALL be properly configured
- **AND** test files SHALL be discoverable and executable
- **AND** test reports SHALL be generated correctly

#### Scenario: Type safety in hook handlers

- **WHEN** hook handler functions are defined
- **THEN** input and output parameters SHALL use typed interfaces (not `any`)
- **AND** types SHALL match the `@opencode-ai/plugin` Hooks API
- **AND** hooks SHALL return `Promise<void>` and mutate output in place

#### Scenario: Test mock compatibility

- **WHEN** test mocks are created for PluginInput
- **THEN** mocks SHALL include all required properties including `serverUrl`
- **AND** TypeScript compilation SHALL succeed without type errors

### Requirement: Test Portability

The test suite SHALL be portable across operating systems and shall not depend on fixed filesystem paths.

#### Scenario: Temporary directory creation

- **WHEN** tests create temporary test directories
- **THEN** the system SHALL use `os.tmpdir()` instead of hardcoded `/tmp`
- **AND** directories SHALL be uniquely named to avoid conflicts

#### Scenario: Cross-platform compatibility

- **WHEN** tests are run on Windows, macOS, or Linux
- **THEN** all tests SHALL pass without modification
- **AND** path separators SHALL be handled correctly

#### Scenario: Test isolation

- **WHEN** multiple test runs occur concurrently
- **THEN** each run SHALL use a unique temporary directory
- **AND** no shared state SHALL cause test interference

### Requirement: Documentation Accuracy

The README documentation SHALL accurately reflect the current implementation behavior.

#### Scenario: Memory management documentation

- **WHEN** the README describes session context storage
- **THEN** it SHALL describe the actual Map-based implementation with cleanup policy
- **AND** it SHALL NOT claim WeakMap usage

#### Scenario: File operation documentation

- **WHEN** the README describes file reading behavior
- **THEN** it SHALL accurately describe synchronous file reads
- **AND** it SHALL NOT claim async file operations if sync operations are used

#### Scenario: Debug logging documentation

- **WHEN** debug logging is available
- **THEN** the README SHALL document the `OPENCODE_RULES_DEBUG` environment variable
- **AND** it SHALL explain what information is logged

#### Scenario: Prompt extraction documentation

- **WHEN** the system extracts user prompts for keyword matching
- **THEN** the README SHALL document the "latest non-synthetic user text" behavior
- **AND** it SHALL explain how synthetic messages are excluded

### Requirement: Installer Must Configure Server and TUI

The package SHALL provide an `npx`-executable installer that registers the plugin in both the OpenCode server config and the OpenCode TUI config. The installer SHALL preserve unrelated plugin entries, create backups before writing, and fail without writing when either config is malformed.

#### Scenario: Fresh install updates both configs

- **WHEN** a user runs `npx opencode-rules-md install`
- **THEN** the plugin SHALL be added to the resolved OpenCode server config `plugin` array
- **AND** the plugin SHALL be added to the resolved OpenCode TUI config `plugin` array
- **AND** unrelated entries in both configs SHALL be preserved

#### Scenario: Re-running install is idempotent

- **WHEN** the installer is run again with the same plugin already present in both configs
- **THEN** the command SHALL complete successfully
- **AND** the configs SHALL remain unchanged

#### Scenario: Malformed config aborts safely

- **WHEN** either resolved config cannot be parsed
- **THEN** the installer SHALL stop before writing
- **AND** the user SHALL receive a clear error message

#### Scenario: TUI remains enabled after install

- **WHEN** the plugin is installed successfully
- **THEN** the plugin's TUI capability SHALL remain available without manual edits
- **AND** the user SHALL not need a separate TUI-only install step

### Requirement: Published Package Must Avoid Downloading Host-Provided TUI Runtime Dependencies

The published package SHALL avoid forcing the installer execution path to download host-provided TUI runtime dependencies. The package SHALL still keep the TUI implementation available to OpenCode at runtime.

#### Scenario: Installer execution avoids unnecessary TUI downloads

- **WHEN** a user runs the installer through `npx`
- **THEN** the installer path SHALL not require downloading OpenTUI runtime packages as part of the CLI execution path

#### Scenario: OpenCode can still load the TUI

- **WHEN** OpenCode loads the installed plugin
- **THEN** the TUI capability SHALL still be resolvable by OpenCode's runtime
- **AND** the plugin SHALL continue to expose its TUI entrypoint

#### Scenario: Server runtime stays available

- **WHEN** the plugin is installed
- **THEN** the server-side rule discovery runtime SHALL still have access to its own direct runtime dependencies
