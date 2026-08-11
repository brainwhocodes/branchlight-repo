# Changelog

## [Unreleased]

### Added

- Added the ChatGPT OAuth settings flow and masked extension-input prompts for credentials that stay outside desktop transcripts.
- Added searchable model selection, every OAuth login provider reported by OMP, automatic-retry control, and categorized agent defaults to the desktop settings workspace.

### Changed

- Changed image-generation timeline entries to show live progress and render generated images inline.
- Changed the chat composer to expose all RPC slash commands in a keyboard-accessible, scrollable fuzzy-search menu while command discovery and prompt acknowledgement stay asynchronous.
- Changed desktop session settings to expose a searchable model catalog plus thinking, fast mode, steering, follow-up, interrupt, automatic-compaction, and automatic-retry controls with explicit loading, stopped-session, success, and failure states.

### Fixed

- Fixed overlapping provider-status refreshes and sign-in attempts stopping the shared authentication RPC process.
- Fixed sent chat messages appearing only after the RPC runtime echoed them by inserting them into history immediately and reconciling the authoritative event without duplication.
- Fixed Branchlight RPC sessions to expose native image generation as a direct tool instead of routing image requests through the generic xdev `write` surface.
- Fixed streamed reasoning updates being dropped from the live desktop timeline or duplicated in restored transcripts.
- Fixed incremental transcript updates rebuilding the timeline and moving readers away from their current scroll position.