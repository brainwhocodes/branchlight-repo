# Changelog

## [Unreleased]

- Added the pure Workspace V1 reducer and application/schema contracts.
- Added immutable command application with authorization, revision, lifecycle, graph, and event ordering invariants.
- Added deterministic snapshot projection and typed effect intents for terminal, browser, agent, service, worktree, remote, and cleanup operations.

### Added

- Added atomic tab layout application to `terminal.open` and `browser.open` reducer mutations with automatic `grid` derivation for 3/4 panes.
- Added `onConnectionState` subscription to `WorkspaceClient` distinguishing requested from unexpected disconnects.
- Added runtime-owned terminal PTY sessions with bounded input, resize, output-history replay, transient subscriptions, and scoped child capabilities.
- Added `shell` and `args` validation to the `terminal.open` reducer allowlist and forwarded them to terminal process startup effects.

### Fixed

- Fixed close entity pane to automatically normalize `grid` tabs to `columns` when 2 panes remain.
### Changed

- Changed terminal effects and status transitions to execute in the authoritative daemon; desktop clients now disconnect without stopping durable panes or the runtime.
