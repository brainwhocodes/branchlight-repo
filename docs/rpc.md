# RPC Protocol Reference

RPC mode exposes the coding agent through an authenticated loopback h2c gRPC
bidirectional stream. The canonical RPC service is
`omp.rpc.v1.AgentService/Connect`, reached at the HTTP/2 path
`/omp.rpc.v1.AgentService/Connect`. Clients may send `application/grpc` or
`application/grpc+proto` content types, with an optional `;...` parameter when
emitted by gRPC libraries. Non-gRPC content types are rejected. Server responses
emit `application/grpc+proto`.

The transport is local-only by design. Hosts start the agent process, read the
bootstrap file described below, open one gRPC stream to the advertised loopback
address, and then exchange typed protobuf envelopes until either side closes the
stream.

## Startup and Bootstrap

```bash
omp --mode rpc [regular CLI options]
```

The agent publishes its connection details through environment variables owned by
the launcher:

| Variable | Required | Meaning |
| --- | --- | --- |
| `OMP_GRPC_HOST` | yes | Loopback host to bind and advertise. Python clients set this to `127.0.0.1`. |
| `OMP_GRPC_PORT` | yes | TCP port for the h2c gRPC server. Use `0` to let the OS choose a free port. |
| `OMP_GRPC_TOKEN` | yes | Bearer token clients must present on every `Connect` call. |
| `OMP_GRPC_READY_FILE` | yes | Path where the agent writes ready JSON after the gRPC listener is listening and before it accepts streams. |

When the server is ready it writes exactly one JSON object to
`OMP_GRPC_READY_FILE`:

```json
{
  "protocol": "grpc",
  "protocolVersion": 1,
  "host": "127.0.0.1",
  "port": 51234,
  "token": "opaque bearer token",
  "maxMessageBytes": 67108864
}
```

Schema:

- `protocol`: always `"grpc"`.
- `protocolVersion`: integer version of this gRPC contract; the current value is
  `1`.
- `host`: loopback host clients connect to.
- `port`: bound TCP port.
- `token`: bearer token required by the gRPC service.
- `maxMessageBytes`: maximum serialized protobuf message size in either
  direction. The canonical limit is 64 MiB (`67108864`).

The agent writes the bootstrap atomically with file mode `0600`; its parent
temporary directory should be private to the launching user.

The ready file is the synchronization point. Clients should reserve a unique path
in a private temporary directory, wait for the agent to atomically write it,
parse it, connect to `host:port`, and then open `Connect` using the returned
token. The host/client removes the ready file and temporary directory after
shutdown.

## Authentication

Every `Connect` stream must include bearer authorization metadata:

```text
authorization: Bearer <token from ready JSON>
```

The server rejects missing, malformed, or mismatched credentials before accepting
the stream. The token is process-local bootstrap material; do not persist it, log
it, or reuse it for another agent process.

## Service and Messages

The canonical schema is [`packages/grpc/proto/omp_rpc.proto`](../packages/grpc/proto/omp_rpc.proto).
The Python distribution checks in an equivalent package-local schema plus
generated modules:

- `omp_rpc/omp_rpc_pb2.py`
- `omp_rpc/omp_rpc_pb2_grpc.py`

Canonical service:
```proto
syntax = "proto3";
package omp.rpc.v1;
service AgentService { rpc Connect(stream ClientFrame) returns (stream ServerFrame); }
message Command { string id = 1; string name = 2; bytes payload_json = 3; bool has_id = 4; }
message Push { string type = 1; bytes payload_json = 2; }
message ClientFrame { oneof frame { Command command = 1; Push push = 2; } }
message Ready { uint32 protocol_version = 1; uint64 max_message_bytes = 2; }
message Response { string id = 1; bool has_id = 2; string command = 3; bool success = 4; bytes data_json = 5; bool has_data = 6; string error = 7; string code = 8; bool has_error = 9; bool has_code = 10; }
message ServerFrame { oneof frame { Ready ready = 1; Response response = 2; Push push = 3; } }
```

The stream carries command requests, command responses, agent/session events,
extension UI traffic, host-tool traffic, host-URI traffic, subagent updates, and
builtin command side channels as protobuf frames. Protobuf fields carry framing
metadata such as ids, frame kinds, command names, and push types. Presence flags
distinguish an omitted optional string from an explicitly empty one.
`payload_json` contains only the dynamic body: command frames reconstruct
`{id,type:name,...payload}`, push frames reconstruct `{type,...payload}`, and
clients must correlate responses by both `id` and command name rather than by
arrival order.

The gRPC transport itself provides message boundaries, flow control, and ordered
delivery within a stream. Clients must not add another byte-stream wrapper.
Large payloads are sent as normal protobuf messages and must stay within the
advertised `maxMessageBytes` limit.

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.
- Ordering across concurrent commands is not guaranteed; clients must match
  responses on `id`.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` even if the request
  had an `id`.
- Synchronous dispatch failures emit `command: "parse"` with `id: undefined`.
  Exceptions while handling a recognized command emit a failure with that
  command's `type` and `id`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a
  later error response with the same `id` if async prompt scheduling fails.
- `prompt` success responses may include `data.agentInvoked`. `false` means the
  prompt completed locally without an agent turn; `true` means the prompt
  produced agent lifecycle events; omitted means the host must rely on session
  events for completion.

## Command Schema

The following list uses reconstructed application-object notation. On the wire,
`Command.id` and `Command.name` carry `id` and `type`; only the remaining fields
are JSON-encoded into `Command.payload_json`.

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

### Settings

- `{ id?, type: "get_settings" }`
- `{ id?, type: "set_setting", path: string, value: boolean | string | number }`

`get_settings` returns the curated, credential-free scalar settings that can be
rendered by non-terminal hosts. Each entry includes its schema path, tab, group,
label, description, control type, current value, finite options when applicable,
and whether the change applies immediately or with the next session.
`set_setting` accepts only a path from that curated surface and validates the
value against the schema before persisting it. Credential paths are never exposed
through either command.

### Files

- `{ id?, type: "get_file_diff", path: string }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`
- `{ id?, type: "get_openrouter_model_routing", modelId: string }`
- `{ id?, type: "set_openrouter_provider_enabled", modelId: string, providerId: string, enabled: boolean }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue Modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` is dispatched concurrently: the RPC server continues handling commands
while the shell command runs. The `bash` response is emitted when the command
completes; hosts correlate it via `id`.

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

### Messages

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` returns a stable chronological page with `messages`,
`totalMessages`, and an opaque `nextCursor` when more messages remain. The
server rejects stale cursors if the session changes between requests, and refuses
to start a paging walk while the session is streaming or compacting. Failed page
requests carry a machine-readable `code` on the error response, such as
`session_busy` or `stale_cursor`, so clients can react without matching
human-readable error text.

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`
- `{ id?, type: "logout", providerId: string }`
- `{ id?, type: "get_oauth_accounts" }`
- `{ id?, type: "set_oauth_account_lock", providerId: string, credentialId?: number }`
- `{ id?, type: "set_oauth_account_failover", enabled: boolean }`
- `{ id?, type: "remove_oauth_account", providerId: string, credentialId: number }`

## Response Schema

Command results use the structured protobuf `Response` message. Correlation and
status metadata live in protobuf fields; only command-specific `data` is
JSON-encoded in `Response.data_json`:

- Success: `{ id?, command: <command>, success: true, data?: ... }`
- Failure: `{ id?, command: string, success: false, error: string, code?: string }`

## Lifecycle and Cleanup

A host normally owns exactly one child agent process and one bidirectional stream
per `RpcClient`. Startup creates a private bearer token, reserves a unique ready
file path, and starts the child. The child starts the gRPC listener, atomically
writes ready JSON after the listener is listening, and then accepts one
authenticated `Connect` stream for that client.

On client close, `RpcClient` closes the active stream, waits for in-flight
handler cleanup, and terminates the child process it started. If the process or
transport exits unexpectedly, pending extension UI, host-tool, and host-URI
requests are failed; accepted commands either complete before shutdown or surface
transport errors to their waiters. Hosts that provide their own process command
remain responsible for any outer supervisor cleanup.

## Go Usage

The process-owning Go SDK is the nested module
`github.com/can1357/oh-my-pi/go/omp-rpc/v17`:

```go
client, err := omprpc.New(omprpc.Config{
    Provider: "anthropic",
    Model:    "claude-sonnet-4-5",
})
if err != nil {
    return err
}
if err := client.Start(ctx); err != nil {
    return err
}
defer client.Close()

state, err := client.GetState(ctx)
```

`Client` validates launch options before startup, owns the authenticated stream
and full child process tree, exposes typed commands/events and host callbacks,
and supports Unix user/group launch credentials. The module's `v17` semantic
import suffix follows the repository release major.

## Python Usage

The Python package exposes a synchronous public `RpcClient` API while internally
using `grpc.aio` for the bidirectional stream:

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    print(state.model.id if state.model else "no model")

    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

By default the client starts:

```bash
omp --mode rpc
```

Pass `command=[...]` to own the exact child command while keeping the same
synchronous client surface:

```python
from omp_rpc import RpcClient

with RpcClient(command=["omp", "--mode", "rpc", "--provider", "anthropic"]) as client:
    print(client.get_state().session_id)
```

The client reads the ready JSON, attaches bearer metadata, enforces the 64 MiB
message limit, manages request correlation, exposes typed notifications, handles
message pagination, and routes extension UI, host-owned tools, and host-owned URI
schemes over the gRPC stream.

## Migration Break

This transport intentionally breaks from the previous JSONL/stdin/protocol-v2/chunk/stdout design. Hosts must remove every assumption about stdin/stdout framing, protocol-v2 negotiation, rpc_chunk reassembly, and unauthenticated process pipes; the only supported live transport is authenticated loopback h2c gRPC through `AgentService.Connect`.
