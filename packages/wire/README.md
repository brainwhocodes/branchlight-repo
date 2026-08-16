# @oh-my-pi/pi-wire

Shared TypeScript wire contracts for omp collab live sessions.

The package contains only JSON-safe protocol shapes and constants. It has no runtime dependencies and is consumed by both the host CLI (`@oh-my-pi/pi-coding-agent`) and browser guest (`@oh-my-pi/collab-web`).

## Exports

```ts
import type { GuestFrame, HostFrame, SessionEntry } from "@oh-my-pi/pi-wire";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH } from "@oh-my-pi/pi-wire";
```

Key groups:

- message and transcript entry shapes rendered by collab guests,
- live agent event and task-subagent bus payload shapes,
- `GuestFrame`, `HostFrame`, and `WireFrame` unions for AES-GCM sealed payloads,
- relay control TEXT messages,
- link/envelope constants shared by host, guest, and local relay code.

## Workspace V1 contracts

Workspace V1 adds JSON-safe document and snapshot shapes for durable workspace topology, locations, tabs, panes, terminals, browsers, previews, agent profiles, capabilities, sessions, services, worktrees, notifications, and cleanup records. Commands carry only transport authentication; the runtime assigns principal and client identity after authentication.

The exported parsers reject unknown versions, malformed IDs, broken graph links, stale generations, oversized payloads, duplicate entity IDs, and durable process/browser identities. `WorkspaceRuntimeProjectionV1` may overlay non-durable health, focus, output cursors, and capability freshness without persisting process IDs, CDP targets, backend node IDs, or bounds.

## Protocol boundary

`pi-wire` does not encode, decode, validate, encrypt, or route frames. It defines the shared contract used at those boundaries:

1. callers build a `GuestFrame` or `HostFrame`,
2. transport code serializes it as JSON inside an encrypted payload,
3. relay code routes opaque envelopes using the plaintext peer-id prefix,
4. receivers switch on `frame.t` and tolerate unknown future fields.

Keep protocol changes backward-aware: bump `COLLAB_PROTO` only when old hosts and guests must reject each other.
