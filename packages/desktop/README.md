# Branchlight

Branchlight is a local terminal and browser workspace for Oh My Pi. It replaces the chat-style desktop client with a tabbed shell built for running OMP beside the pages it controls.

## Workspace behavior

- Open terminal tabs and browser tabs from the top tab strip.
- Split a terminal tab into terminals only, or a browser tab into browsers only.
- Arrange two panes as columns or rows. Three and four panes use a compact grid.
- Keep the browser address bar inside each browser pane. Terminal panes never render browser controls.
- Rename browser tabs and address them from OMP by that name.
- Keep shells rooted in the repository that launched Branchlight.

A terminal tab uses `ghostty-web` for its WebAssembly VT parser and canvas renderer. Shell processes run through Bun's native PTY support, which uses ConPTY on Windows. The Electron main process owns the PTY worker and forwards only typed terminal events through preload IPC.

Browser panes are sandboxed Electron `WebContentsView` instances. Branchlight exposes their DevTools targets on a loopback-only port and injects that endpoint into every terminal as `PI_BROWSER_CDP_URL`. OMP's browser tool connects to the endpoint automatically. Set the browser tool's `name` to a Branchlight browser tab name to target it directly; split panes use `<tab name> / 1`, `<tab name> / 2`, and so on.

## Launching

From this repository, an argument-free `omp` command opens Branchlight and uses the current directory as the workspace. The first launch builds the repository's desktop backend when `packages/coding-agent/dist/omp.exe` is absent.

Inside a Branchlight terminal, `omp` resolves to that repository-built executable and starts the normal OMP terminal interface in the pane. `BRANCHLIGHT_TERMINAL=1` prevents recursive desktop launches. To keep the normal terminal-only behavior outside Branchlight, run:

```sh
OMP_DESKTOP=0 omp
```

## Architecture

| Layer | Location | Responsibility |
|---|---|---|
| Electron main process | `src/main/` | Window lifecycle, browser views, loopback CDP, native terminal bridge, and OS integration |
| Terminal worker | `../coding-agent/src/desktop-terminal/` | Bun PTY lifecycle and JSONL terminal protocol |
| Preload bridge | `src/main/preload.ts` | Narrow, validated browser and terminal IPC boundary |
| Svelte renderer | `src/renderer/` | Tabs, homogeneous splits, pane controls, Ghostty WASM terminal surfaces, and responsive layout |
| Shared contracts | `src/shared/` and `../wire/` | Renderer IPC and terminal-worker messages |
| OMP backend | `../coding-agent/` | Agent runtime and browser automation |

Branchlight remains in the Oh My Pi workspace because it imports shared contracts and packages the workspace-built OMP executable.

## Requirements

- Windows 10 or 11 on x64 for the current packaged backend.
- Bun matching the workspace toolchain.
- Workspace dependencies installed from the repository root.

## Development

From the repository root:

```sh
bun install
cd packages/desktop
bun run backend:build
bun run start
```

`backend:build` compiles the OMP executable used by terminals and packaged builds. `start` launches Electron Forge with Vite development servers.

## Verification

```sh
cd packages/desktop
bun run check
bun run test
bun run test:e2e
```

The Playwright journey launches the real Electron shell with a deterministic terminal worker. It verifies:

- terminal startup through the typed bridge and Ghostty WASM renderer;
- terminal-only and browser-only split invariants;
- browser-local address bars;
- browser tab creation, naming, and CDP target discovery;
- interaction with a named browser target through Puppeteer;
- responsive layout, window controls, and serious accessibility violations.

## Packaging

```sh
bun run backend:build
bun run package
```

Electron Forge writes the unpacked application under `out/`. Packaged resources include `omp.exe`, Branchlight's RPC defaults, and third-party notices.

## Local data and security

- Renderer context isolation, sandboxing, Electron fuses, and a restrictive content security policy remain enabled.
- Browser panes accept only HTTP and HTTPS navigation. Popups become new Branchlight browser tabs.
- Browser DevTools access binds to `127.0.0.1`; it is not exposed to the local network.
- Browser panes have Node integration disabled and deny permission requests by default.
- OMP owns provider credentials and session data under its local data directory.

## License and notices

Branchlight is licensed under the repository's [MIT License](../../LICENSE). Bundled icon, font, and terminal dependencies are recorded in [`THIRD_PARTY_LICENSES.txt`](./THIRD_PARTY_LICENSES.txt).
