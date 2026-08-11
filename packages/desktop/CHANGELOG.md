# Changelog

## [Unreleased]

### Added

- Added the ChatGPT OAuth settings flow and masked extension-input prompts for credentials that stay outside desktop transcripts.

### Changed

- Changed image-generation timeline entries to show live progress and render generated images inline.
- Changed the chat composer to expose all RPC slash commands in a keyboard-accessible, scrollable fuzzy-search menu while command discovery and prompt acknowledgement stay asynchronous.
- Changed desktop session settings to expose model, thinking, fast mode, steering, follow-up, interrupt, and automatic-compaction controls with explicit loading, stopped-session, success, and failure states.

### Fixed

- Fixed overlapping provider-status refreshes and sign-in attempts stopping the shared authentication RPC process.
- Fixed Branchlight RPC sessions to enable native image generation and render nested xdev image results as successful inline output.
- Fixed streamed reasoning updates being dropped from the live desktop timeline or duplicated in restored transcripts.
- Fixed incremental transcript updates rebuilding the timeline and moving readers away from their current scroll position.