from pathlib import Path

BOOTSTRAP = Path("packages/workspace-runtime/src/bootstrap.ts")
RUNTIME_ENTRY = Path("packages/coding-agent/src/desktop-terminal/runtime-server-entry.ts")

bootstrap = BOOTSTRAP.read_text()
interface_anchor = '''\texecutablePath?: string;
\tconnectTimeoutMs?: number;
'''
interface_replacement = '''\texecutablePath?: string;
\tserverEntryPath?: string;
\tconnectTimeoutMs?: number;
'''
if interface_anchor not in bootstrap:
    raise SystemExit("Workspace runtime options anchor not found")
bootstrap = bootstrap.replace(interface_anchor, interface_replacement, 1)

spawn_anchor = '''\t\tconst execPath = options.executablePath ?? process.execPath;
\t\tconst isCompiledBinary = !execPath.endsWith("bun") && !execPath.endsWith("bun.exe");
\t\tconst spawnArgs = isCompiledBinary
\t\t\t? [WORKER_RUNTIME_SERVER_SELECTOR]
\t\t\t: [path.join(import.meta.dir, "cli.ts"), WORKER_RUNTIME_SERVER_SELECTOR];
'''
spawn_replacement = '''\t\tconst execPath = options.executablePath ?? process.execPath;
\t\tconst isCompiledBinary = !execPath.endsWith("bun") && !execPath.endsWith("bun.exe");
\t\tconst serverEntryPath = options.serverEntryPath ?? path.join(import.meta.dir, "cli.ts");
\t\tconst spawnArgs = isCompiledBinary
\t\t\t? [WORKER_RUNTIME_SERVER_SELECTOR]
\t\t\t: [serverEntryPath, WORKER_RUNTIME_SERVER_SELECTOR];
'''
if spawn_anchor not in bootstrap:
    raise SystemExit("Workspace runtime spawn anchor not found")
BOOTSTRAP.write_text(bootstrap.replace(spawn_anchor, spawn_replacement, 1))

entry = RUNTIME_ENTRY.read_text()
url_import_anchor = 'import * as path from "node:path";\n'
if url_import_anchor not in entry:
    raise SystemExit("Runtime entry import anchor not found")
entry = entry.replace(url_import_anchor, url_import_anchor + 'import { fileURLToPath } from "node:url";\n', 1)

helper_anchor = '''import { WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime/server";

export async function startRuntimeServerFromEnvironment(): Promise<void> {
'''
helper_replacement = '''import { WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime/server";

function resolveSourceRuntimeServerEntry(): string | undefined {
\tconst execPath = process.execPath;
\tif (!execPath.endsWith("bun") && !execPath.endsWith("bun.exe")) return undefined;
\treturn fileURLToPath(import.meta.resolve("@oh-my-pi/pi-workspace-runtime/cli"));
}

export async function startRuntimeServerFromEnvironment(): Promise<void> {
'''
if helper_anchor not in entry:
    raise SystemExit("Runtime entry helper anchor not found")
entry = entry.replace(helper_anchor, helper_replacement, 1)

smoke_anchor = '''\t\tconst descriptor = await ensureWorkspaceRuntime({
\t\t\truntimeDir: tmpDir,
\t\t\tconnectTimeoutMs: 3000,
'''
smoke_replacement = '''\t\tconst descriptor = await ensureWorkspaceRuntime({
\t\t\truntimeDir: tmpDir,
\t\t\tserverEntryPath: resolveSourceRuntimeServerEntry(),
\t\t\tconnectTimeoutMs: 3000,
'''
if smoke_anchor not in entry:
    raise SystemExit("Runtime smoke bootstrap anchor not found")
RUNTIME_ENTRY.write_text(entry.replace(smoke_anchor, smoke_replacement, 1))
