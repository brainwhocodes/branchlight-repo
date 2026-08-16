from pathlib import Path

LOCAL_RUNTIME = Path("packages/utils/src/local-runtime.ts")
CLI = Path("packages/coding-agent/src/cli.ts")
COMPUTER_WORKER_ENTRY = Path("packages/coding-agent/src/tools/computer/worker-entry.ts")
EXPORT_TEMPLATE_TEST = Path("packages/coding-agent/test/export-html-template.test.ts")

local_runtime = LOCAL_RUNTIME.read_text()
native_import = 'import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";\n'
if native_import not in local_runtime:
    raise SystemExit("local-runtime native import anchor not found")
local_runtime = local_runtime.replace(
    native_import,
    'import type { Process as NativeProcess } from "@oh-my-pi/pi-natives";\n',
    1,
)

identity_start = local_runtime.index("function readProcessIdentityToken(")
identity_end = local_runtime.index("export interface ProcessShutdownOptions", identity_start)
identity_replacement = r'''const LINUX_PROCESS_START_TOKEN_PREFIX = "linux-procfs-v1:";

interface ObservedProcessIdentity {
\tstatus: "running" | "dead" | "unverifiable";
\tstartToken?: string;
}

type NativeProcessClass = (typeof import("@oh-my-pi/pi-natives"))["Process"];
let nativeProcessClassPromise: Promise<NativeProcessClass | undefined> | undefined;

function loadNativeProcessClass(): Promise<NativeProcessClass | undefined> {
\tnativeProcessClassPromise ??= import("@oh-my-pi/pi-natives")
\t\t.then(module => module.Process)
\t\t.catch(() => undefined);
\treturn nativeProcessClassPromise;
}

function readNativeProcessIdentityToken(processRef: NativeProcess): string | undefined {
\ttry {
\t\tconst token = processRef.identityToken;
\t\treturn typeof token === "string" && token.length > 0 ? token : undefined;
\t} catch {
\t\treturn undefined;
\t}
}

async function observeLinuxProcess(pid: number): Promise<ObservedProcessIdentity | undefined> {
\tif (process.platform !== "linux") return undefined;
\ttry {
\t\tconst stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
\t\tconst commandEnd = stat.lastIndexOf(")");
\t\tif (commandEnd < 0) return { status: "unverifiable" };
\t\tconst fields = stat
\t\t\t.slice(commandEnd + 2)
\t\t\t.trim()
\t\t\t.split(/\s+/);
\t\tconst state = fields[0];
\t\tconst startTime = fields[19];
\t\tif (state === "Z" || state === "X" || state === "x") return { status: "dead" };
\t\tif (!startTime || !/^\d+$/.test(startTime)) return { status: "unverifiable" };
\t\treturn { status: "running", startToken: `${LINUX_PROCESS_START_TOKEN_PREFIX}${startTime}` };
\t} catch (error) {
\t\tconst code = (error as NodeJS.ErrnoException).code;
\t\tif (code === "ENOENT" || code === "ESRCH") return { status: "dead" };
\t\treturn { status: "unverifiable" };
\t}
}

async function observeNativeProcess(pid: number): Promise<ObservedProcessIdentity> {
\tconst ProcessClass = await loadNativeProcessClass();
\tif (!ProcessClass) return { status: "unverifiable" };
\ttry {
\t\tconst processRef = ProcessClass.fromPid(pid);
\t\tif (!processRef || String(processRef.status()) !== "running") return { status: "dead" };
\t\tconst startToken = readNativeProcessIdentityToken(processRef);
\t\treturn startToken ? { status: "running", startToken } : { status: "unverifiable" };
\t} catch {
\t\treturn { status: "unverifiable" };
\t}
}

/** Inspect a fresh PID and compare its kernel start/birth token. */
export async function inspectProcessIdentity(identity: ProcessIdentity): Promise<ProcessIdentityInspection> {
\tif (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return { pid: identity.pid, status: "dead" };
\tconst expectedStartToken = identity.startToken;
\tconst observation = expectedStartToken.startsWith(LINUX_PROCESS_START_TOKEN_PREFIX)
\t\t? await observeLinuxProcess(identity.pid)
\t\t: await observeNativeProcess(identity.pid);
\tif (!observation || observation.status === "unverifiable") {
\t\treturn { pid: identity.pid, status: "unverifiable", expectedStartToken };
\t}
\tif (observation.status === "dead") return { pid: identity.pid, status: "dead", expectedStartToken };
\tconst observedStartToken = observation.startToken;
\tif (!observedStartToken) return { pid: identity.pid, status: "unverifiable", expectedStartToken };
\treturn {
\t\tpid: identity.pid,
\t\texpectedStartToken,
\t\tobservedStartToken,
\t\tstatus: observedStartToken === expectedStartToken ? "matched" : "mismatched",
\t};
}

export async function captureProcessIdentity(
\tpid: number,
): Promise<ProcessIdentityInspection & { identity?: ProcessIdentity }> {
\tif (!Number.isSafeInteger(pid) || pid <= 0) return { pid, status: "dead" };
\tconst observation = (await observeLinuxProcess(pid)) ?? (await observeNativeProcess(pid));
\tif (observation.status === "dead") return { pid, status: "dead" };
\tif (observation.status !== "running" || !observation.startToken) return { pid, status: "unverifiable" };
\tconst identity = { pid, startToken: observation.startToken };
\treturn {
\t\tpid,
\t\tstatus: "matched",
\t\tobservedStartToken: observation.startToken,
\t\texpectedStartToken: observation.startToken,
\t\tidentity,
\t};
}

'''
local_runtime = local_runtime[:identity_start] + identity_replacement + local_runtime[identity_end:]

shutdown_start = local_runtime.index("/** Gracefully stop a verified process tree")
shutdown_end = local_runtime.index("/** Verify an authenticated opaque token", shutdown_start)
shutdown_replacement = r'''/** Gracefully stop a verified process tree, with bounded force fallback and no PID-only action. */
export async function shutdownProcessTree(
\tidentity: ProcessIdentity,
\toptions: ProcessShutdownOptions = {},
): Promise<ProcessShutdownResult> {
\tconst gracefulMs = Math.max(0, Math.floor(options.gracefulMs ?? 1_000));
\tconst forceMs = Math.max(1, Math.floor(options.forceMs ?? 2_000));
\tlet inspection = await inspectProcessIdentity(identity);
\tif (inspection.status !== "matched") return { ...inspection, graceful: false, forced: false };
\tconst ProcessClass = await loadNativeProcessClass();
\tif (!ProcessClass) return { ...inspection, graceful: false, forced: false };
\ttry {
\t\tconst processRef = ProcessClass.fromPid(identity.pid);
\t\tif (!processRef) return { ...inspection, status: "dead", graceful: false, forced: false };
\t\tif (process.platform === "win32") {
\t\t\tconst timeout = Promise.withResolvers<boolean>();
\t\t\tconst timer = setTimeout(() => timeout.resolve(false), gracefulMs + forceMs);
\t\t\ttry {
\t\t\t\tconst stopped = await Promise.race([
\t\t\t\t\tprocessRef.terminate({ group: true, gracefulMs, timeoutMs: forceMs }),
\t\t\t\t\ttimeout.promise,
\t\t\t\t]);
\t\t\t\treturn { ...(await inspectProcessIdentity(identity)), graceful: stopped, forced: !stopped };
\t\t\t} finally {
\t\t\t\tclearTimeout(timer);
\t\t\t}
\t\t}
\t\tprocessRef.killTree(15);
\t\tconst stopped = await processRef.waitForExit({ timeoutMs: gracefulMs });
\t\tif (stopped) return { ...(await inspectProcessIdentity(identity)), graceful: true, forced: false };
\t\tinspection = await inspectProcessIdentity(identity);
\t\tif (inspection.status !== "matched") return { ...inspection, graceful: false, forced: false };
\t\tconst forceRef = ProcessClass.fromPid(identity.pid);
\t\tif (!forceRef) return { ...inspection, status: "dead", graceful: false, forced: false };
\t\tforceRef.killTree(9);
\t\tawait forceRef.waitForExit({ timeoutMs: forceMs });
\t\treturn { ...(await inspectProcessIdentity(identity)), graceful: false, forced: true };
\t} catch {
\t\treturn { ...(await inspectProcessIdentity(identity)), graceful: false, forced: false };
\t}
}

'''
local_runtime = local_runtime[:shutdown_start] + shutdown_replacement + local_runtime[shutdown_end:]
LOCAL_RUNTIME.write_text(local_runtime)

cli = CLI.read_text()
for line in (
    'import { launchWorkspaceFromCurrentRepo } from "./desktop-terminal/launcher";\n',
    'import { smokeTestRuntimeServer, startRuntimeServerFromEnvironment } from "./desktop-terminal/runtime-server-entry";\n',
    'import { startJsEvalProcess } from "./eval/js/process-entry";\n',
):
    if line not in cli:
        raise SystemExit(f"CLI import anchor not found: {line.strip()}")
    cli = cli.replace(line, "", 1)

smoke_anchor = '\tconst { smokeTestComputerWorker } = await import("./tools/computer/supervisor");\n'
if smoke_anchor not in cli:
    raise SystemExit("CLI smoke-test import anchor not found")
cli = cli.replace(
    smoke_anchor,
    smoke_anchor + '\tconst { smokeTestRuntimeServer } = await import("./desktop-terminal/runtime-server-entry");\n',
    1,
)

js_process_anchor = '''\tif (arg === JS_EVAL_PROCESS_ARG) {
\t\t// The bootstrap-safe interceptor seam is linked statically so this selector
'''
if js_process_anchor not in cli:
    raise SystemExit("CLI JS process selector anchor not found")
cli = cli.replace(
    js_process_anchor,
    '''\tif (arg === JS_EVAL_PROCESS_ARG) {
\t\tconst { startJsEvalProcess } = await import("./eval/js/process-entry");
\t\t// The bootstrap-safe interceptor seam is linked statically so this selector
''',
    1,
)

runtime_anchor = '''\tif (arg === RUNTIME_SERVER_WORKER_ARG) {
\t\tawait startRuntimeServerFromEnvironment();
'''
if runtime_anchor not in cli:
    raise SystemExit("CLI runtime selector anchor not found")
cli = cli.replace(
    runtime_anchor,
    '''\tif (arg === RUNTIME_SERVER_WORKER_ARG) {
\t\tconst { startRuntimeServerFromEnvironment } = await import("./desktop-terminal/runtime-server-entry");
\t\tawait startRuntimeServerFromEnvironment();
''',
    1,
)

workspace_anchor = '\tif (isProcessEntry && resolvedArgv.length === 0 && (await launchWorkspaceFromCurrentRepo(process.cwd()))) return;\n'
if workspace_anchor not in cli:
    raise SystemExit("CLI workspace launch anchor not found")
cli = cli.replace(
    workspace_anchor,
    '''\tif (isProcessEntry && resolvedArgv.length === 0) {
\t\tconst { launchWorkspaceFromCurrentRepo } = await import("./desktop-terminal/launcher");
\t\tif (await launchWorkspaceFromCurrentRepo(process.cwd())) return;
\t}
''',
    1,
)
CLI.write_text(cli)

COMPUTER_WORKER_ENTRY.write_text(r'''import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import type { ComputerWorkerInbound, ComputerWorkerTransport } from "./protocol";

let started = false;

/** Starts the computer worker once while keeping lightweight health checks addon-free. */
export function startComputerWorker(): void {
\tif (started || !parentPort) return;
\tstarted = true;
\tconst port = parentPort;
\tconst inbox = consumeWorkerInbox();
\tconst transport: ComputerWorkerTransport = {
\t\tsend(message, transfer) {
\t\t\tport.postMessage(message, transfer ?? []);
\t\t},
\t\tonMessage(handler) {
\t\t\tif (inbox) return inbox.bind(message => handler(message as ComputerWorkerInbound));
\t\t\tconst listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
\t\t\tport.on("message", listener);
\t\t\treturn () => port.off("message", listener);
\t\t},
\t\tclose() {
\t\t\tport.close();
\t\t},
\t};

\tconst pending: ComputerWorkerInbound[] = [];
\tlet coreLoading: Promise<void> | undefined;
\tlet unsubscribeBootstrap: (() => void) | undefined;

\tconst loadCore = (): void => {
\t\tcoreLoading ??= import("./worker")
\t\t\t.then(({ ComputerWorkerCore }) => {
\t\t\t\tunsubscribeBootstrap?.();
\t\t\t\tunsubscribeBootstrap = undefined;
\t\t\t\tconst core = new ComputerWorkerCore(transport);
\t\t\t\tfor (const message of pending.splice(0)) core.handle(message);
\t\t\t})
\t\t\t.catch(error => {
\t\t\t\tqueueMicrotask(() => {
\t\t\t\t\tthrow error;
\t\t\t\t});
\t\t\t});
\t};

\tunsubscribeBootstrap = transport.onMessage(message => {
\t\tif (!coreLoading && message.type === "ping") {
\t\t\ttransport.send({ type: "pong", id: message.id });
\t\t\treturn;
\t\t}
\t\tif (!coreLoading && message.type === "close") {
\t\t\tunsubscribeBootstrap?.();
\t\t\tunsubscribeBootstrap = undefined;
\t\t\ttransport.send({ type: "closed" });
\t\t\ttransport.close();
\t\t\treturn;
\t\t}
\t\tpending.push(message);
\t\tloadCore();
\t});

\t// The supervisor waits for readiness before sending its first run. The native
\t// desktop implementation is loaded only after that first substantive message.
\ttransport.send({ type: "ready" });
}

// Direct-source fallback: loaded as a worker's entry module outside a CLI
// host there is no selector argv, so start immediately. When any CLI-host
// worker re-enters cli.ts, the selector guard defers to the host's dispatch.
if (!Bun.argv.some(isWorkerHostSelector)) {
\tstartComputerWorker();
}
''')

template_test = EXPORT_TEMPLATE_TEST.read_text()
old_hash = "72721b125d8eaa0e995ef0b77e01cf561c9a76e36e745510b19734def07936e0"
new_hash = "5de40cf049ec821af043d0b451957cb742d8e806fe1e012a50c7297f1d91c7f1"
if old_hash not in template_test:
    raise SystemExit("HTML template checksum anchor not found")
EXPORT_TEMPLATE_TEST.write_text(template_test.replace(old_hash, new_hash, 1))
