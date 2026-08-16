package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	omprpcv1 "github.com/can1357/oh-my-pi/go/omp-rpc/v17/internal/gen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

type fixtureServer struct {
	omprpcv1.UnimplementedAgentServiceServer
	token  string
	sendMu sync.Mutex
}

func (s *fixtureServer) send(stream omprpcv1.AgentService_ConnectServer, frame *omprpcv1.ServerFrame) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	return stream.Send(frame)
}
func (s *fixtureServer) response(stream omprpcv1.AgentService_ConnectServer, command *omprpcv1.Command, data any) error {
	raw, _ := json.Marshal(data)
	return s.send(stream, &omprpcv1.ServerFrame{Frame: &omprpcv1.ServerFrame_Response{Response: &omprpcv1.Response{Id: command.Id, HasId: true, Command: command.Name, Success: true, DataJson: raw, HasData: true}}})
}
func (s *fixtureServer) push(stream omprpcv1.AgentService_ConnectServer, kind string, payload any) error {
	raw, _ := json.Marshal(payload)
	return s.send(stream, &omprpcv1.ServerFrame{Frame: &omprpcv1.ServerFrame_Push{Push: &omprpcv1.Push{Type: kind, PayloadJson: raw}}})
}

func (s *fixtureServer) Connect(stream omprpcv1.AgentService_ConnectServer) error {
	metadataValues, _ := metadata.FromIncomingContext(stream.Context())
	if got := metadataValues.Get("authorization"); len(got) != 1 || got[0] != "Bearer "+s.token {
		return errors.New("missing bearer token")
	}
	version := uint32(1)
	if os.Getenv("OMP_FIXTURE_BAD_READY") == "1" {
		version = 2
	}
	if err := s.send(stream, &omprpcv1.ServerFrame{Frame: &omprpcv1.ServerFrame_Ready{Ready: &omprpcv1.Ready{ProtocolVersion: version, MaxMessageBytes: maxMessageBytes}}}); err != nil {
		return err
	}
	if os.Getenv("OMP_FIXTURE_CLOSE_AFTER_READY") == "1" {
		return nil
	}
	for {
		frame, err := stream.Recv()
		if err != nil {
			return err
		}
		if push := frame.GetPush(); push != nil {
			var payload JSON
			_ = json.Unmarshal(push.PayloadJson, &payload)
			payload["clientType"] = push.Type
			_ = s.push(stream, "fixture_client_push", payload)
			continue
		}
		command := frame.GetCommand()
		if command == nil {
			continue
		}
		var payload JSON
		_ = json.Unmarshal(command.PayloadJson, &payload)
		switch command.Name {
		case "slow":
			continue
		case "fail":
			_ = s.send(stream, &omprpcv1.ServerFrame{Frame: &omprpcv1.ServerFrame_Response{Response: &omprpcv1.Response{Id: command.Id, HasId: true, Command: command.Name, Success: false, Error: "rejected", HasError: true, Code: "E_FIXTURE", HasCode: true}}})
		case "first", "second":
			delay := 80 * time.Millisecond
			if command.Name == "second" {
				delay = 5 * time.Millisecond
			}
			copied := &omprpcv1.Command{
				Id: command.Id, HasId: command.HasId, Name: command.Name, PayloadJson: append([]byte(nil), command.PayloadJson...),
			}
			go func() { time.Sleep(delay); _ = s.response(stream, copied, JSON{"value": copied.Name}) }()
		case "prompt":
			_ = s.response(stream, command, JSON{})
			_ = s.push(stream, "agent_start", JSON{})
			_ = s.push(stream, "message_start", JSON{"message": JSON{"role": "assistant", "content": []any{JSON{"type": "text", "text": "hello"}}}})
			_ = s.push(stream, "agent_end", JSON{"messages": []any{JSON{"role": "assistant", "content": []any{JSON{"type": "text", "text": "hello"}}}}, "messageCount": 1, "isTerminal": true})
		case "set_host_tools":
			var descriptors []JSON
			raw, _ := json.Marshal(payload["tools"])
			_ = json.Unmarshal(raw, &descriptors)
			names := make([]string, 0, len(descriptors))
			for _, descriptor := range descriptors {
				if name, ok := descriptor["name"].(string); ok {
					names = append(names, name)
				}
			}
			_ = s.response(stream, command, JSON{"toolNames": names})
			for _, name := range names {
				requestID := "tool_" + name
				_ = s.push(stream, "host_tool_call", JSON{"id": requestID, "toolName": name, "toolCallId": "call_" + name, "arguments": JSON{"value": "ok"}})
				if name == "cancel" {
					go func(id string) {
						time.Sleep(20 * time.Millisecond)
						_ = s.push(stream, "host_tool_cancel", JSON{"targetId": id})
					}(requestID)
				}
			}
		case "set_host_uri_schemes":
			_ = s.response(stream, command, JSON{"schemes": []string{"mem"}})
			_ = s.push(stream, "host_uri_request", JSON{"id": "uri_read", "operation": "read", "url": "mem://item"})
			_ = s.push(stream, "host_uri_request", JSON{"id": "uri_write", "operation": "write", "url": "mem://item", "content": "next"})
			_ = s.push(stream, "host_uri_request", JSON{"id": "uri_cancel", "operation": "read", "url": "mem://cancel"})
			go func() {
				time.Sleep(20 * time.Millisecond)
				_ = s.push(stream, "host_uri_cancel", JSON{"targetId": "uri_cancel"})
			}()
		case "ui":
			_ = s.response(stream, command, JSON{})
			_ = s.push(stream, "extension_ui_request", JSON{"id": "confirm", "method": "confirm"})
			_ = s.push(stream, "extension_ui_request", JSON{"id": "select", "method": "select", "options": []string{"one"}})
		default:
			_ = s.response(stream, command, payload)
		}
	}
}

func TestFixtureProcess(t *testing.T) {
	if os.Getenv("OMP_RPC_GO_FIXTURE") != "1" {
		t.Skip("fixture subprocess only")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.MaxRecvMsgSize(maxMessageBytes), grpc.MaxSendMsgSize(maxMessageBytes))
	omprpcv1.RegisterAgentServiceServer(server, &fixtureServer{token: os.Getenv("OMP_GRPC_TOKEN")})
	address := listener.Addr().(*net.TCPAddr)
	readyPath := os.Getenv("OMP_GRPC_READY_FILE")
	body, _ := json.Marshal(bootstrap{Protocol: "grpc", ProtocolVersion: protocolVersion, Host: "127.0.0.1", Port: address.Port, Token: os.Getenv("OMP_GRPC_TOKEN"), MaxMessageBytes: maxMessageBytes})
	temporary := readyPath + ".tmp"
	if err = os.WriteFile(temporary, body, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(temporary, readyPath); err != nil {
		t.Fatal(err)
	}
	if err = server.Serve(listener); err != nil {
		t.Fatal(err)
	}
}

func fixtureClient(t *testing.T, mutate func(*Config)) *Client {
	t.Helper()
	config := Config{Command: []string{os.Args[0], "-test.run=TestFixtureProcess"}, Env: map[string]string{"OMP_RPC_GO_FIXTURE": "1"}, StartupTimeout: 5 * time.Second, RequestTimeout: time.Second}
	if mutate != nil {
		mutate(&config)
	}
	client, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = client.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestAuthenticatedReadyCorrelationEventsAndPrompt(t *testing.T) {
	client := fixtureClient(t, nil)
	typed := make(chan *AgentEndEvent, 1)
	client.OnAgentEnd(func(event *AgentEndEvent) { typed <- event })
	type outcome struct {
		value string
		err   error
	}
	results := make(chan outcome, 2)
	for _, command := range []string{"first", "second"} {
		command := command
		go func() {
			result, err := client.Request(context.Background(), command, JSON{})
			value, _ := result["value"].(string)
			results <- outcome{value: value, err: err}
		}()
	}
	seen := map[string]bool{}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		seen[result.value] = true
	}
	if !seen["first"] || !seen["second"] {
		t.Fatalf("out-of-order correlation failed: %#v", seen)
	}
	turn, err := client.PromptAndWait(context.Background(), "hello", PromptOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if turn.AssistantText != "hello" || len(turn.Events) < 2 {
		t.Fatalf("unexpected prompt turn: %#v", turn)
	}
	select {
	case <-typed:
	case <-time.After(time.Second):
		t.Fatal("typed agent_end listener was not called")
	}
}

func TestCommandErrorTimeoutAndReadyValidation(t *testing.T) {
	client := fixtureClient(t, nil)
	_, err := client.Request(context.Background(), "fail", JSON{})
	var commandError *CommandError
	if !errors.As(err, &commandError) || commandError.Code != "E_FIXTURE" {
		t.Fatalf("unexpected command error: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err = client.Request(ctx, "slow", JSON{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected timeout, got %v", err)
	}
	bad, newErr := New(Config{Command: []string{os.Args[0], "-test.run=TestFixtureProcess"}, Env: map[string]string{"OMP_RPC_GO_FIXTURE": "1", "OMP_FIXTURE_BAD_READY": "1"}, StartupTimeout: 5 * time.Second})
	if newErr != nil {
		t.Fatal(newErr)
	}
	if err = bad.Start(context.Background()); err == nil {
		_ = bad.Close()
		t.Fatal("unsupported Ready version was accepted")
	}
}

func TestHostToolAndURIRoundTripsAndCancellation(t *testing.T) {
	client := fixtureClient(t, nil)
	pushes := make(chan UnknownNotification, 16)
	client.OnNotification(func(notification Notification) {
		if unknown, ok := notification.(UnknownNotification); ok {
			pushes <- unknown
		}
	})
	cancelled := make(chan struct{}, 1)
	tools := []HostTool{{Name: "echo", Description: "echo", Parameters: JSON{"type": "object"}, Execute: func(ctx context.Context, arguments JSON, call *HostToolContext) (HostToolResult, error) {
		_ = call.SendUpdate(TextToolResult("working"))
		return TextToolResult(arguments["value"].(string)), nil
	}}, {Name: "cancel", Description: "cancel", Parameters: JSON{}, Execute: func(ctx context.Context, arguments JSON, call *HostToolContext) (HostToolResult, error) {
		<-ctx.Done()
		cancelled <- struct{}{}
		return HostToolResult{}, ctx.Err()
	}}}
	if _, err := client.SetCustomTools(context.Background(), tools); err != nil {
		t.Fatal(err)
	}
	writes := make(chan string, 1)
	uriCancelled := make(chan struct{}, 1)
	immutable := true
	uris := []HostURI{{Scheme: "mem", Write: func(ctx context.Context, rawURL, content string, request *HostURIContext) error {
		writes <- content
		return nil
	}, Read: func(ctx context.Context, rawURL string, request *HostURIContext) (HostURIReadResult, error) {
		if rawURL == "mem://cancel" {
			<-ctx.Done()
			uriCancelled <- struct{}{}
			return HostURIReadResult{}, ctx.Err()
		}
		return HostURIReadResult{Content: "body", ContentType: "text/plain", Immutable: &immutable}, nil
	}}}
	if _, err := client.SetHostURIs(context.Background(), uris); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-writes:
		if value != "next" {
			t.Fatalf("unexpected URI write %q", value)
		}
	case <-time.After(time.Second):
		t.Fatal("URI write was not dispatched")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("host tool cancellation was not delivered")
	}
	select {
	case <-uriCancelled:
	case <-time.After(time.Second):
		t.Fatal("host URI cancellation was not delivered")
	}
	observed := 0
	deadline := time.After(2 * time.Second)
	for observed < 4 {
		select {
		case notification := <-pushes:
			if notification.Payload["clientType"] != nil {
				observed++
			}
		case <-deadline:
			t.Fatalf("only observed %d callback frames", observed)
		}
	}
}

func TestHeadlessUIRoundTrip(t *testing.T) {
	client := fixtureClient(t, nil)
	pushes := make(chan UnknownNotification, 4)
	client.OnUnknownNotification(func(notification UnknownNotification) { pushes <- notification })
	unsubscribe := client.InstallHeadlessUI(HeadlessUIOptions{})
	defer unsubscribe()
	if _, err := client.RequestRaw(context.Background(), "ui", JSON{}); err != nil {
		t.Fatal(err)
	}
	responses := make(map[string]JSON)
	deadline := time.After(time.Second)
	for len(responses) < 2 {
		select {
		case notification := <-pushes:
			if notification.Payload["clientType"] == "extension_ui_response" {
				if id, ok := notification.Payload["id"].(string); ok {
					responses[id] = notification.Payload
				}
			}
		case <-deadline:
			t.Fatalf("headless UI emitted only %#v", responses)
		}
	}
	if responses["confirm"]["confirmed"] != false {
		t.Fatalf("confirmation default was not false: %#v", responses["confirm"])
	}
	if responses["select"]["cancelled"] != true {
		t.Fatalf("select default was not cancelled: %#v", responses["select"])
	}
}

func TestTransportExitCleansOwnedProcess(t *testing.T) {
	client := fixtureClient(t, func(config *Config) {
		config.Env["OMP_FIXTURE_CLOSE_AFTER_READY"] = "1"
	})
	client.mu.Lock()
	done := client.processDone
	tempDir := client.tempDir
	client.mu.Unlock()
	select {
	case <-client.closed:
	case <-time.After(time.Second):
		t.Fatal("transport exit did not close the client")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("transport exit did not terminate the owned process")
	}
	var processError *ProcessExitError
	if err := client.WaitForIdle(context.Background()); !errors.As(err, &processError) {
		t.Fatalf("transport exit did not preserve its process error: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		_, err := os.Stat(tempDir)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("transport exit did not remove bootstrap directory: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCloseUnblocksPendingRequest(t *testing.T) {
	client := fixtureClient(t, nil)
	result := make(chan error, 1)
	go func() { _, err := client.Request(context.Background(), "slow", JSON{}); result <- err }()
	time.Sleep(20 * time.Millisecond)
	_ = client.Close()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("pending request succeeded after close")
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not unblock pending request")
	}
}

func TestCommandOptions(t *testing.T) {
	falseValue := false
	tools := []string{}
	configured, err := New(Config{Executable: filepath.Join("bin", "omp"), Provider: "p", Model: "m", SessionDir: "sessions", Thinking: "high", AppendSystemPrompt: "system", ProviderSessionID: "provider-session", Tools: tools, NoSession: true, NoSkills: true, NoRules: true, NoTitle: &falseValue, ExtraArgs: []string{"--flag"}})
	if err != nil {
		t.Fatal(err)
	}
	command := configured.Command()
	got := fmt.Sprint(command)
	for _, expected := range []string{"--mode rpc", "--provider p", "--model m", "--session-dir sessions", "--thinking high", "--append-system-prompt system", "--provider-session-id provider-session", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--flag"} {
		if !containsWords(got, expected) {
			t.Fatalf("command %q missing %q", got, expected)
		}
	}
	if containsWords(got, "--no-title") {
		t.Fatalf("explicit false no-title ignored: %q", got)
	}
}
func containsWords(value, fragment string) bool {
	return len(fragment) == 0 || len(value) >= len(fragment) && index(value, fragment) >= 0
}
func index(value, fragment string) int {
	for position := range len(value) - len(fragment) + 1 {
		if value[position:position+len(fragment)] == fragment {
			return position
		}
	}
	return -1
}
