# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the Work and Code chat surfaces with a tabbed terminal and browser workspace.

### Added

- Added unified single-selection lifecycle with bounded DOM/screenshot capture and explicit awaited delivery.
- Added platform-normalized keyboard shortcuts (`Cmd` on macOS / `Ctrl` elsewhere) with active input and terminal canvas filtering.
- Added position-aware browser bounds with zoom factor scaling and automatic geometry recomputation.
- Added light/dark native browser background synchronization and live OS `nativeTheme` support.
- Added automatic reconnection to workspace runtime with bounded backoff and terminal offset replay.
- Added the ChatGPT OAuth settings flow and masked extension-input prompts for credentials that stay outside desktop transcripts.
- Added every OAuth login provider reported by OMP and categorized, session-independent agent defaults, including native image generation and inspection controls.
- Added homogeneous terminal and browser splits, a Ghostty WebAssembly terminal renderer backed by the authoritative workspace runtime, and durable browser presentation rehydration.
- Added a native right-click pane menu for splitting terminal or browser panes right or down and closing split panes.
- Connected desktop settings across theme switching (`dark`, `light`, `system`), tab close confirmation gating, browser search engine templates, default workspace paths, and reactive Ghostty terminal font, cursor, and palette styling without relaunch.
- Added stored OAuth account management in settings, including lock/unlock, sibling failover, and account removal controls.

### Changed

- Changed the settings surface to use the dark terminal/browser workspace palette.
- Changed terminal PTYs, terminal output history, browser intent, and capability leases to be owned by one persistent workspace runtime daemon per Electron user-data root; normal desktop shutdown now disconnects presentation only.
- Changed desktop agent supervision to use an authenticated gRPC bidirectional stream over loopback HTTP/2 instead of child-process stdin/stdout framing.
- Limited native image generation to OpenAI API and ChatGPT/Codex subscription providers.
- Scoped browser navigation controls to browser panes so terminal tabs never render an address bar.
- Changed desktop session processes to a bounded three-runtime supervisor with FIFO admission, least-recently-used pressure eviction, and five-minute idle shutdown.

### Fixed

- Fixed `App.svelte` shortcut handler intercepting `Ctrl+W` in terminal/form fields.
- Fixed close operations (`closeBrowser`, `closeTab`, `closeTerminal`) tearing down resources before runtime confirmation.
- Fixed multi-pane split creation to atomically apply tab layout invariants.
- Fixed duplicate document synchronization during event batch delivery.
- Fixed stale incoming document URLs rolling back in-flight browser navigation.
- Fixed terminal failure states rendering as indefinite starting spinners.
- Fixed Bun workspace Electron discovery and Electron Forge's Vite 8 integration.
- Fixed overlapping provider-status refreshes and sign-in attempts stopping the shared authentication RPC process.
- Fixed Branchlight RPC sessions to expose native image generation as a direct tool instead of routing image requests through the generic xdev `write` surface.
- Fixed the new-tab menu being clipped or covered by an active native browser pane.
- Fixed OMP processes launched from runtime-owned terminal panes attaching only after a real session exists, using a terminal-scoped capability lease that is revoked on terminal replacement or close.
- Fixed workspace tabs using uniform widths that truncated titles instead of sizing to their full labels.
### Removed

- Removed the Electron-local terminal host, terminal bridge, and renderer-supplied terminal credential registration path.
- Removed the chat composer, transcript timeline, and Work/Code mode switch from the active desktop renderer.