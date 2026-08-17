<p align="center">
  <img src="packages/desktop/resources/icon.png" width="132" alt="Mars Kommander logo">
</p>

<h1 align="center">Mars Kommander</h1>

<p align="center">
  A self-contained desktop command center for Oh My Pi.
</p>

<p align="center">
  <a href="https://github.com/brainwhocodes/branchlight-repo/actions/workflows/desktop-build.yml"><img src="https://img.shields.io/github/actions/workflow/status/brainwhocodes/branchlight-repo/desktop-build.yml?branch=main&label=desktop%20builds" alt="Desktop build status"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-111111?logo=apple" alt="macOS Apple Silicon and Intel">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows11&logoColor=white" alt="Windows 10 and 11">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/brainwhocodes/branchlight-repo" alt="License"></a>
</p>

<p align="center">
  <img src="docs/assets/mars-kommander-app.png" alt="Mars Kommander Electron app showing the OMP Chat workspace" width="1200">
</p>

Mars Kommander turns the OMP runtime into a focused Electron workspace. Chat with the agent, review its technical record, inspect changed files, follow subagents, and keep a real browser beside the conversation without installing a separate terminal harness.

The packaged application contains Electron, the renderer, the local workspace runtime, and a compiled OMP executable. End users do not need Bun, Node.js, or a separate OMP installation.

## What is inside

- **OMP Chat** for Work and Code sessions, streaming output, steering, follow-ups, interrupts, models, and thinking controls.
- **Reviewable technical history** with tool activity, reasoning, changed files, diffs, and session recovery.
- **Subagent visibility** with per-agent status and transcript inspection.
- **Integrated browser workspaces** with multiple tabs and split panes next to the chat.
- **Local-first state** for workspaces, sessions, credentials, and runtime files.
- **Contained desktop builds** for macOS and 64-bit Windows 10/11.

## Desktop artifacts

The `Mars Kommander desktop builds` workflow creates native artifacts on native GitHub-hosted runners:

| Platform | Artifact |
| --- | --- |
| macOS Apple Silicon | `Mars-Kommander-macOS-arm64.zip` |
| macOS Intel | `Mars-Kommander-macOS-x64.zip` |
| Windows 10/11 x64 | `MarsKommanderSetup.exe` and a portable ZIP |

Each build verifies that the packaged application contains a runnable OMP backend before the artifact is uploaded. Pull requests, `main` pushes, version tags, and manual workflow runs all produce downloadable build artifacts.

> [!NOTE]
> Pull-request artifacts are development builds. Unless signing credentials are configured later, macOS may require **Open** from Finder's context menu and Windows may display a SmartScreen warning.

## Build locally

Mars Kommander uses Bun 1.3.14 and Electron Forge.

```sh
git clone https://github.com/brainwhocodes/branchlight-repo.git
cd branchlight-repo
bun install --frozen-lockfile
```

Build the native addon that matches the current computer, then create the contained desktop artifact:

```sh
bun scripts/bazel-natives.ts host --dest packages/natives/native
bun --cwd=packages/desktop run make:contained
```

On macOS, the command writes a ZIP containing `Mars Kommander.app`. On Windows, it writes a Squirrel installer, update package, and portable ZIP. Generated files live in `packages/desktop/dist`.

## Develop

```sh
bun run desktop:start
```

Useful checks:

```sh
bun run desktop:check
bun run desktop:test
bun --cwd=packages/desktop run test:e2e:packaged
```

To regenerate the README screenshot after packaging a Linux development build:

```sh
xvfb-run -a bun --cwd=packages/desktop run docs:screenshot
```

## Architecture

Mars Kommander is intentionally thin around OMP:

1. Electron owns the native window, security boundaries, file dialogs, browser views, and lifecycle.
2. The Svelte renderer presents OMP Chat, session history, settings, diffs, and browser workspaces.
3. A local workspace runtime persists tabs, panes, profiles, and browser state.
4. The packaged OMP executable runs RPC sessions and streams events back into the desktop application.

The existing Branchlight-prefixed internal protocol and environment names remain implementation details so stored workspaces and test fixtures continue to work.

## Project status

Mars Kommander is under active development. The desktop pipeline validates packaged shells and bundled OMP executables on macOS and Windows, but release signing, notarization, automatic updates, and store distribution remain separate release-engineering steps.
