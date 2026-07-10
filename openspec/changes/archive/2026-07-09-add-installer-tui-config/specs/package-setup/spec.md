## ADDED Requirements
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
