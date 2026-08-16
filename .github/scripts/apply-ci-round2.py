from pathlib import Path

RPC_CLIENT = Path("packages/coding-agent/src/modes/rpc/rpc-client.ts")
INSTALL_SMOKE = Path("scripts/install-tests/run-ci.sh")
RELEASE_PUBLISH = Path("scripts/ci-release-publish.ts")
BROWSER_PUBLISH_CONFIG = Path("packages/browser-runtime/tsconfig.publish.json")
WORKSPACE_PUBLISH_CONFIG = Path("packages/workspace-runtime/tsconfig.publish.json")

rpc = RPC_CLIENT.read_text()
old_reader_catch = '''\t\t} catch (cause) {
\t\t\tif (this.#process !== child) return;
\t\t\tconst error = cause instanceof Error ? cause : new Error(String(cause));
\t\t\tawait this.#handleTransportFailure(
\t\t\t\tchild,
\t\t\t\tnew Error(`Agent gRPC reader failed: ${error.message}`, { cause: error }),
\t\t\t);
\t\t}
\t}

\t#handleServerFrame'''
new_reader_catch = '''\t\t} catch (cause) {
\t\t\tif (this.#process !== child) return;
\t\t\tconst readerError = cause instanceof Error ? cause : new Error(String(cause));
\t\t\tconst failure = await this.#resolveReaderFailure(child, readerError);
\t\t\tif (this.#process !== child) return;
\t\t\tawait this.#handleTransportFailure(child, failure);
\t\t}
\t}

\tasync #resolveReaderFailure(child: ptree.ChildProcess, readerError: Error): Promise<Error> {
\t\tconst timeout = Promise.withResolvers<{ kind: "timeout" }>();
\t\tconst timer = setTimeout(() => timeout.resolve({ kind: "timeout" }), 250);
\t\ttimer.unref();
\t\ttry {
\t\t\tconst observed = await Promise.race([
\t\t\t\tchild.exited.then(
\t\t\t\t\texitCode => ({
\t\t\t\t\t\tkind: "exit" as const,
\t\t\t\t\t\terror: new Error(`Agent process exited with code ${exitCode}. Stderr: ${child.peekStderr()}`),
\t\t\t\t\t}),
\t\t\t\t\tcause => ({
\t\t\t\t\t\tkind: "exit" as const,
\t\t\t\t\t\terror: new Error(`Agent process exited unexpectedly. Stderr: ${child.peekStderr()}`, { cause }),
\t\t\t\t\t}),
\t\t\t\t),
\t\t\t\ttimeout.promise,
\t\t\t]);
\t\t\tif (observed.kind === "exit") return observed.error;
\t\t} finally {
\t\t\tclearTimeout(timer);
\t\t}
\t\treturn new Error(`Agent gRPC reader failed: ${readerError.message}`, { cause: readerError });
\t}

\t#handleServerFrame'''
if old_reader_catch not in rpc:
    raise SystemExit("RPC reader failure anchor not found")
RPC_CLIENT.write_text(rpc.replace(old_reader_catch, new_reader_catch, 1))

install = INSTALL_SMOKE.read_text()
replacements = [
    (
        "for pkg in utils grpc wire omptype hashline catalog ai mnemopi snapcompact agent tui stats collab-web; do",
        "for pkg in utils grpc wire browser-runtime omptype hashline catalog ai mnemopi snapcompact agent tui stats collab-web workspace-runtime; do",
    ),
    (
        'wire_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-wire-*.tgz)"\n',
        'wire_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-wire-*.tgz)"\n'
        'browser_runtime_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-browser-runtime-*.tgz)"\n',
    ),
    (
        'collab_web_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-collab-web-*.tgz)"\n',
        'collab_web_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-collab-web-*.tgz)"\n'
        'workspace_runtime_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-workspace-runtime-*.tgz)"\n',
    ),
    (
        "\t\t\t'@oh-my-pi/pi-wire': '$wire_tgz',\n",
        "\t\t\t'@oh-my-pi/pi-wire': '$wire_tgz',\n"
        "\t\t\t'@oh-my-pi/pi-browser-runtime': '$browser_runtime_tgz',\n",
    ),
    (
        "\t\t\t'@oh-my-pi/collab-web': '$collab_web_tgz'\n",
        "\t\t\t'@oh-my-pi/collab-web': '$collab_web_tgz',\n"
        "\t\t\t'@oh-my-pi/pi-workspace-runtime': '$workspace_runtime_tgz'\n",
    ),
    (
        '   bun add "$utils_tgz" "$grpc_tgz" "$wire_tgz" "$omptype_tgz" "$natives_tgz" "$hashline_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$collab_web_tgz"\n',
        '   bun add "$utils_tgz" "$grpc_tgz" "$wire_tgz" "$browser_runtime_tgz" "$omptype_tgz" "$natives_tgz" "$hashline_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$collab_web_tgz" "$workspace_runtime_tgz"\n',
    ),
]
for old, new in replacements:
    if old not in install:
        raise SystemExit(f"Install smoke anchor not found: {old!r}")
    install = install.replace(old, new, 1)
INSTALL_SMOKE.write_text(install)

release = RELEASE_PUBLISH.read_text()
release_replacements = [
    (
        '\t{ dir: "packages/wire", kind: "typescript" },\n',
        '\t{ dir: "packages/wire", kind: "typescript" },\n'
        '\t{ dir: "packages/browser-runtime", kind: "typescript" },\n',
    ),
    (
        '\t{ dir: "packages/natives", kind: "native" },\n',
        '\t{ dir: "packages/natives", kind: "native" },\n'
        '\t{ dir: "packages/workspace-runtime", kind: "typescript" },\n',
    ),
]
for old, new in release_replacements:
    if old not in release:
        raise SystemExit(f"Release package anchor not found: {old!r}")
    release = release.replace(old, new, 1)
RELEASE_PUBLISH.write_text(release)

publish_config = '''{
\t"extends": "./tsconfig.json",
\t"compilerOptions": {
\t\t"noEmit": false,
\t\t"emitDeclarationOnly": true,
\t\t"declaration": true,
\t\t"declarationMap": false,
\t\t"sourceMap": false,
\t\t"inlineSources": false,
\t\t"rootDir": "src",
\t\t"outDir": "dist/types",
\t\t"noCheck": true
\t},
\t"include": ["src"],
\t"exclude": ["dist", "node_modules", "test"]
}
'''
if BROWSER_PUBLISH_CONFIG.exists() or WORKSPACE_PUBLISH_CONFIG.exists():
    raise SystemExit("Publish config already exists")
BROWSER_PUBLISH_CONFIG.write_text(publish_config)
WORKSPACE_PUBLISH_CONFIG.write_text(publish_config)
