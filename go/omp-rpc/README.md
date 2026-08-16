# omp RPC Go SDK

`omprpc` is the process-owning Go client for the canonical `omp.rpc.v1.AgentService/Connect` stream. It launches `omp --mode rpc`, validates the atomic loopback bootstrap file, authenticates with a per-process bearer token, and owns process-tree cleanup.

## Install

```sh
go get github.com/can1357/oh-my-pi/go/omp-rpc/v17
```

```go
client, err := omprpc.New(omprpc.Config{
    Provider: "anthropic",
    Model: "claude-sonnet-4-5",
    Cwd: workspace,
})
if err != nil {
    return err
}
if err = client.Start(ctx); err != nil {
    return err
}
defer client.Close()

turn, err := client.PromptAndWait(ctx, "Explain this repository", omprpc.PromptOptions{})
if err != nil {
    return err
}
text, err := turn.RequireAssistantText()
```

Every command accepts `context.Context`. `RequestRaw` exposes commands without a typed wrapper. Concurrent commands are correlated by request id; `PromptAndWait`, `WaitForIdle`, and `CollectEvents` intentionally reject overlap on one client.

## Events and UI

Use `OnNotification`, `OnEvent`, or typed registrations such as `OnMessageUpdate` and `OnAgentEnd`. Registration returns an idempotent unsubscribe function. Listener panics are isolated and retained in `ListenerErrors`.

Non-interactive programs can call `InstallHeadlessUI`. It declines confirmations by default, ignores passive requests, and cancels select/input/editor requests unless configured values are supplied.

## Host tools and URIs

`SetCustomTools` registers concurrent Go callbacks with progress updates and cancellation contexts. `SetHostURIs` serves custom read/write URI schemes. Both may be called before `Start`; registered descriptors are sent after Ready.

## Generated protocol

The checked-in bindings under `internal/gen` are generated directly from the repository's single canonical schema at `../../packages/grpc/proto/omp_rpc.proto`. The deterministic `go:generate` directive in `generate.go` supplies the semantic-import-version mapping; the schema is not duplicated in this module.
