from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    source = file_path.read_text()
    if old not in source:
        raise SystemExit(f"cleanup anchor not found in {path}: {old!r}")
    file_path.write_text(source.replace(old, new, 1))


replace_once(
    "packages/browser-runtime/src/browser-service.ts",
    "\t\tfor (const [cdpUrl, conn] of this.#connections) {\n",
    "\t\tfor (const conn of this.#connections.values()) {\n",
)

replace_once(
    "packages/browser-runtime/src/selection-channel.ts",
    "\t\tconst maxNodes = Math.min(options.maxNodes ?? SELECTION_LIMITS.maxDomNodes, SELECTION_LIMITS.maxDomNodes);\n\n",
    "",
)

replace_once(
    "packages/desktop/src/main/main.ts",
    """\t\t\tlet doc: WorkspaceDocumentV1;
\t\t\ttry {
\t\t\t\tconst initialDocument = runtimeClient.document ?? (await runtimeClient.getDocument());
\t\t\t\tawait ensureDefaultWorkspace(runtimeClient);
\t\t\t\tdoc = runtimeClient.document ?? initialDocument;
\t\t\t} catch (error) {
""",
    """\t\t\ttry {
\t\t\t\tawait ensureDefaultWorkspace(runtimeClient);
\t\t\t} catch (error) {
""",
)

replace_once(
    "packages/desktop/src/main/workspace-host.ts",
    """\t#client?: WorkspaceClient;
\t#settingsStore?: AppSettingsStore;
\t#cdpUrl?: string;
\tconstructor(
\t\twindow: Electron.BaseWindow & { webContents?: Electron.WebContents },
\t\tsettingsStoreOrCdpUrl?: AppSettingsStore | string,
\t\tcdpUrl = "http://127.0.0.1:9222",
\t) {
\t\tthis.#window = window;
\t\tif (typeof settingsStoreOrCdpUrl === "string") {
\t\t\tthis.#cdpUrl = settingsStoreOrCdpUrl;
\t\t} else {
\t\t\tthis.#settingsStore = settingsStoreOrCdpUrl;
\t\t\tthis.#cdpUrl = cdpUrl;
\t\t}
""",
    """\t#client?: WorkspaceClient;
\t#settingsStore?: AppSettingsStore;
\tconstructor(
\t\twindow: Electron.BaseWindow & { webContents?: Electron.WebContents },
\t\tsettingsStoreOrCdpUrl?: AppSettingsStore | string,
\t\tcdpUrl = "http://127.0.0.1:9222",
\t) {
\t\tthis.#window = window;
\t\tif (typeof settingsStoreOrCdpUrl !== "string") {
\t\t\tthis.#settingsStore = settingsStoreOrCdpUrl;
\t\t}
\t\t// Retained for constructor compatibility with older callers.
\t\tvoid cdpUrl;
""",
)

replace_once(
    "packages/desktop/src/main/workspace-host.ts",
    "\t\t\tfor (const [id, entry] of this.#browsers) {\n",
    "\t\t\tfor (const id of this.#browsers.keys()) {\n",
)

replace_once(
    "packages/desktop/test/workspace-host-browser-navigation.test.ts",
    """const mockLoadURL = vi.fn().mockResolvedValue(undefined);
const mockEventHandlers: Record<string, Function[]> = {};
""",
    """const mockLoadURL = vi.fn().mockResolvedValue(undefined);
type MockEventHandler = (...args: unknown[]) => void;
const mockEventHandlers: Record<string, MockEventHandler[]> = {};
""",
)

replace_once(
    "packages/desktop/test/workspace-host-browser-navigation.test.ts",
    "\t\t\ton: (event: string, handler: Function) => {\n",
    "\t\t\ton: (event: string, handler: MockEventHandler) => {\n",
)

replace_once(
    "packages/desktop/test/workspace-host-reconnect.test.ts",
    "\t\tconst { host, send } = createHost();\n",
    "\t\tconst { host } = createHost();\n",
)

replace_once(
    "packages/desktop/test/workspace-host-reconnect.test.ts",
    "\t\tawait (host as unknown as { createTerminal: Function }).createTerminal({\n",
    """\t\tawait (
\t\t\thost as unknown as {
\t\t\t\tcreateTerminal: (input: Record<string, unknown>) => Promise<unknown>;
\t\t\t}
\t\t).createTerminal({
""",
)
