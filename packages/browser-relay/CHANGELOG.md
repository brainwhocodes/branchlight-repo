# Changelog

## [Unreleased]
### Changed

- Changed the relay smoke harness to exercise the Playwright 1.62.1 CDP client against the unpacked extension and OMP-managed Chromium.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
