# Branchlight

Branchlight is a local terminal and browser workspace for Oh My Pi. It replaces the chat-style desktop client with a tabbed shell for working beside the pages it controls, whether or not OMP is installed on the shell's `PATH`.

## Workspace behavior

- Open terminal tabs and browser tabs from the top tab strip.
- Split a terminal tab into terminals only, or a browser tab into browsers only.
- Arrange two panes as columns or rows. Three and four panes use a compact grid.
- Right-click any terminal or browser pane to split it right or down, or to close it.
- Keep the browser address bar inside each browser pane. Terminal panes never render browser controls.
- Rename browser tabs and persist browser navigation in the workspace runtime.
- Start regular login shells rooted in the workspace path, with a sanitized inherited environment and runtime-scoped OMP attachment credentials.

A terminal tab uses `ghostty-web` for its WebAssembly VT parser and canvas renderer. The authoritative workspace runtime daemon owns terminal PTYs, bounded output history, input/resize leases, and durable terminal lifecycle. Electron forwards only presentation and user input through preload IPC.

Browser panes are sandboxed Electron `WebContentsView` instances projected from durable runtime browser records. Visible browser use remains available in every pane; runtime authorization is exact to the workspace, pane, terminal generation, and capability lease. Branchlight does not expose a global Electron CDP port or correlate targets by title or URL.

## Settings and image tools

Branchlight no longer embeds Work or Code chat sessions. If `omp` is available on the inherited `PATH`, run it inside a terminal tab like any other command; the desktop shell remains focused on terminals, browser targets, and global configuration.

The settings surface manages credential-free OMP defaults without opening a session runtime. Native image generation and delegated image inspection remain configurable under **Tools**, and changes persist through OMP's settings RPC.

Provider credentials stay outside the renderer. Settings show stored account identities and active or locked state, support an explicit per-provider account lock, sibling-account failover, account removal, and provider sign-in or sign-out.

## Launching

From this repository, an argument-free `omp` command opens Branchlight and uses the current directory as the workspace. The workspace runtime owns terminal startup and injects only its trusted OMP executable directory into terminal `PATH`.

To keep normal terminal-only behavior when launching an installed OMP command outside Branchlight, run:

```sh
OMP_DESKTOP=0 omp
```

## Architecture

| Electron main process | `src/main/` | Window lifecycle, browser `WebContentsView` presentation, preload IPC, and runtime-client connection |
| Workspace runtime | `../workspace-runtime/` | Durable workspace document, authoritative terminal PTYs, capability leases, browser intent, and lifecycle effects |
| Preload bridge | `src/main/preload.ts` | Narrow, validated browser, terminal, and workspace IPC boundary |
| Svelte renderer | `src/renderer/` | Runtime-projected tabs, homogeneous splits, pane controls, Ghostty WASM terminal surfaces, and responsive layout |
| Shared contracts | `src/shared/` and `../wire/` | Renderer IPC, workspace document, command, and terminal stream contracts |
| OMP backend | `../coding-agent/` | OMP process launched inside runtime-owned terminal panes; it attaches only through a scoped runtime token |

Branchlight starts one workspace runtime daemon under the Electron user-data root. Desktop shutdown disconnects presentation clients but leaves the durable document and PTYs running; explicit runtime shutdown is separate.

## Requirements

- Windows 10 or 11 on x64, macOS, or Linux on a platform supported by the OMP backend and Electron.
- [Bun](https://bun.sh/) matching the workspace toolchain.
- Workspace dependencies installed from the repository root.

## Development

From the repository root:

```sh
bun install
cd packages/desktop
bun run backend:build
bun run start
```

`backend:build` compiles the OMP executable used by runtime-owned terminal shells. `start` builds that backend before launching Electron Forge with Vite development servers.

## Verification

```sh
cd packages/desktop
bun run check
bun run test
bun run test:e2e
```

The focused Vitest coverage verifies runtime-owned PTY startup, bounded terminal streams, durable command transitions, browser presentation, and native pane menu routing. The Playwright journey launches the real Electron shell and verifies:

- the chatless terminal/browser shell and dark settings palette;
- native image-generation and image-inspection settings persistence;
- provider sign-in, account lock/unlock, sibling failover, removal, and sign-out;
- runtime-owned shell startup through the workspace client and Ghostty WASM renderer;
- terminal-only and browser-only split invariants;
- native right-click split and close actions for terminal and browser panes;
- browser-local address bars, tab naming, durable navigation, and browser rehydration;
- presentation disconnect without terminal/browser closure on normal desktop shutdown;
- responsive layout, window controls, and serious accessibility violations.

## Packaging

```sh
bun run backend:build
bun run package
```

Electron Forge writes the unpacked application under `out/`. The packaged resources include the OMP executable used to bootstrap the workspace runtime, Branchlight's RPC defaults, and third-party notices.

## Local data and security

- Renderer context isolation, sandboxing, Electron fuses, and a restrictive content security policy remain enabled.
- Browser panes accept only HTTP and HTTPS navigation. Popups become new Branchlight browser tabs.
- Browser DevTools access binds to `127.0.0.1`; it is not exposed to the local network.
- Browser panes have Node integration disabled and deny permission requests by default.
- OMP owns provider credentials and session data under its local data directory.

## License and notices

Branchlight is licensed under the repository's [MIT License](../../LICENSE). Bundled icon, font, and terminal dependencies are recorded in [`THIRD_PARTY_LICENSES.txt`](./THIRD_PARTY_LICENSES.txt).
