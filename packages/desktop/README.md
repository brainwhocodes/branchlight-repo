# Branchlight

Branchlight is a local desktop workspace for running Oh My Pi agent sessions without leaving the full technical record behind. It provides two focused views:

- **Work** for outcome-oriented research, documents, and generated files.
- **Code** for implementation, debugging, tool calls, reasoning, and collaborator activity.

The application is an Electron and Svelte client over OMP's versioned RPC protocol. Sessions, credentials, transcripts, and generated artifacts stay on the local machine unless a configured model provider processes a request.

## Current capabilities

- Create, resume, stop, and rename local Work and Code sessions.
- Stream assistant messages, reasoning traces, tool progress, notices, and generated images into one timeline.
- Preserve the reader's transcript position while new events arrive; follow new output automatically when already at the bottom.
- Search all available slash commands from the composer with keyboard navigation.
- Configure model, thinking level, fast mode, steering, follow-up, interrupt, and automatic compaction behavior.
- Sign in to ChatGPT Plus or Pro through the official browser flow.
- Use native image generation in desktop RPC sessions; generated images render inline.
- Inspect explicit Work outputs and Code-session technical details without exposing credential material.

## Architecture

| Layer | Location | Responsibility |
|---|---|---|
| Electron main process | `src/main/` | Window lifecycle, local session registry, OMP process supervision, RPC projection, and OS integrations |
| Preload bridge | `src/main/preload.ts` | Narrow, typed IPC boundary exposed to the renderer |
| Svelte renderer | `src/renderer/` | Work and Code interfaces, timeline, composer, settings, and accessibility behavior |
| Shared contracts | `src/shared/` | IPC, RPC, session, and timeline types shared across processes |
| OMP backend | `../coding-agent/` | Agent runtime, provider access, tools, session persistence, and RPC server |

Branchlight currently lives inside the Oh My Pi workspace because it imports shared RPC framing and packages the workspace-built `omp.exe` backend.

## Requirements

- Windows 10 or 11 on x64 for the current packaged backend.
- [Bun](https://bun.sh/) matching the workspace toolchain.
- Workspace dependencies installed from the repository root.
- A configured model provider. ChatGPT Plus or Pro can be connected from Branchlight Settings.

## Development

From the repository root:

```sh
bun install
cd packages/desktop
bun run backend:build
bun run start
```

`backend:build` compiles the OMP executable used by development and packaged builds. `start` launches Electron Forge with Vite development servers and rebuilds the main and preload bundles.

## Verification

Run the desktop checks and contract tests:

```sh
cd packages/desktop
bun run check
bun run test
bun run test:e2e
```

The Playwright journey launches the real Electron shell against a deterministic RPC fixture. It covers session supervision, settings, authentication prompts, slash commands, streamed reasoning, native image presentation, transcript scroll anchoring, Work outputs, Code details, responsive layout, and serious accessibility violations.

To exercise a locally authenticated OMP backend instead of the fixture:

```sh
bun run test:e2e:real
```

This real-backend journey can contact configured providers and should only be run with credentials intended for local development.

## Packaging

Build the backend before packaging:

```sh
bun run backend:build
bun run package
```

Electron Forge writes the unpacked application under `out/`. The packaged resources include `omp.exe`, Branchlight's RPC defaults, and third-party notices.

## Local data and security

- The desktop registry is stored in Electron's per-user application-data directory.
- OMP owns session transcripts and provider credentials under its local data directory.
- OAuth access and refresh tokens are never sent through renderer IPC.
- Password-style extension input is masked and excluded from the transcript.
- External URLs open through the operating system rather than inside the privileged Electron window.
- Renderer isolation and Electron fuses are configured in `forge.config.ts`.

## License and notices

Branchlight is licensed under the repository's [MIT License](../../LICENSE). Bundled icon and font attribution is recorded in [`THIRD_PARTY_LICENSES.txt`](./THIRD_PARTY_LICENSES.txt).
