package omprpc

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	omprpcv1 "github.com/can1357/oh-my-pi/go/omp-rpc/v17/internal/gen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type bootstrap struct {
	Protocol        string `json:"protocol"`
	ProtocolVersion uint32 `json:"protocolVersion"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Token           string `json:"token"`
	MaxMessageBytes uint64 `json:"maxMessageBytes"`
}
type pendingResponse struct {
	command string
	ch      chan responseResult
}
type responseResult struct {
	raw json.RawMessage
	err error
}
type indexedEvent struct {
	index uint64
	event AgentEvent
}

// Listener receives a decoded notification. It must return promptly; listeners run on the receive goroutine.
type Listener func(Notification)

// EventListener receives a decoded agent lifecycle event.
type EventListener func(AgentEvent)
type firstFrameResult struct {
	frame *omprpcv1.ServerFrame
	err   error
}

// Client owns one omp process and one authenticated AgentService.Connect stream.
type Client struct {
	cfg                    Config
	mu                     sync.Mutex
	sendMu                 sync.Mutex
	startMu                sync.Mutex
	stream                 omprpcv1.AgentService_ConnectClient
	callbackWG             sync.WaitGroup
	conn                   *grpc.ClientConn
	cmd                    *exec.Cmd
	tree                   *processTree
	processDone            chan error
	tempDir                string
	cancel                 context.CancelFunc
	closed                 chan struct{}
	closeOnce              sync.Once
	requestID              atomic.Uint64
	pending                map[string]pendingResponse
	listeners              map[uint64]Listener
	eventListeners         map[uint64]EventListener
	typedListeners         map[string]map[uint64]EventListener
	protocolListeners      map[uint64]func(*ProtocolError)
	listenerErrorListeners map[uint64]func(ListenerError)
	nextListener           uint64
	events                 []indexedEvent
	eventOffset            uint64
	eventSignal            chan struct{}
	stderr                 []string
	protocolErrors         []*ProtocolError
	listenerErrors         []ListenerError
	uiRequests             chan ExtensionUIRequest
	scheduled              uint64
	completed              uint64
	asyncErr               error
	lifecycle              string
	hostTools              map[string]HostTool
	hostToolDispatchNames  map[string]string
	hostURIs               map[string]HostURI
	callbackCancels        map[string]context.CancelFunc
}

// New validates configuration and creates a stopped client. Call Start before issuing commands.
func New(config Config) (*Client, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	if err := validatePlatformConfig(config); err != nil {
		return nil, err
	}
	config = config.normalized()
	client := &Client{cfg: config, closed: make(chan struct{}), pending: make(map[string]pendingResponse), listeners: make(map[uint64]Listener), eventListeners: make(map[uint64]EventListener), typedListeners: make(map[string]map[uint64]EventListener), protocolListeners: make(map[uint64]func(*ProtocolError)), listenerErrorListeners: make(map[uint64]func(ListenerError)), eventSignal: make(chan struct{}, 1), uiRequests: make(chan ExtensionUIRequest, 64), hostTools: make(map[string]HostTool), hostURIs: make(map[string]HostURI), callbackCancels: make(map[string]context.CancelFunc), hostToolDispatchNames: make(map[string]string)}
	for _, tool := range config.HostTools {
		if tool.Name == "" || tool.Execute == nil {
			return nil, errors.New("host tools require a name and execute handler")
		}
		client.hostTools[tool.Name] = tool
	}
	for _, uri := range config.HostURIs {
		normalized, err := normalizeHostURI(uri)
		if err != nil {
			return nil, err
		}
		client.hostURIs[normalized.Scheme] = normalized
	}
	return client, nil
}

// Command returns the exact command and arguments Start will execute.
func (c *Client) Command() []string { return c.cfg.command() }

// Start launches omp, validates its atomic bootstrap file, authenticates, and opens the stream.
func (c *Client) Start(ctx context.Context) error {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	c.mu.Lock()
	select {
	case <-c.closed:
		c.mu.Unlock()
		return errors.New("omp RPC client is closed")
	default:
	}
	if c.cmd != nil || c.stream != nil {
		c.mu.Unlock()
		return errors.New("omp RPC client is already started")
	}
	c.mu.Unlock()
	startCtx, cancel := context.WithTimeout(ctx, c.cfg.StartupTimeout)
	defer cancel()
	tempDir, err := os.MkdirTemp("", "omp-grpc-")
	if err != nil {
		return fmt.Errorf("create bootstrap directory: %w", err)
	}
	bootstrapPath := filepath.Join(tempDir, "bootstrap.json")
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		os.RemoveAll(tempDir)
		return fmt.Errorf("create authentication token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	command := c.cfg.command()
	if len(command) == 0 {
		os.RemoveAll(tempDir)
		return errors.New("empty omp command")
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = c.cfg.Cwd
	cmd.Env = mergedEnv(c.cfg.Env, map[string]string{"OMP_GRPC_HOST": "127.0.0.1", "OMP_GRPC_PORT": "0", "OMP_GRPC_TOKEN": token, "OMP_GRPC_READY_FILE": bootstrapPath})
	if err = configureProcess(cmd, c.cfg); err != nil {
		os.RemoveAll(tempDir)
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		os.RemoveAll(tempDir)
		return fmt.Errorf("open omp stderr: %w", err)
	}
	if err = cmd.Start(); err != nil {
		os.RemoveAll(tempDir)
		return fmt.Errorf("start omp: %w", err)
	}
	tree, err := attachProcessTree(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		os.RemoveAll(tempDir)
		return err
	}
	processDone := make(chan error, 1)
	c.mu.Lock()
	c.cmd = cmd
	c.tree = tree
	c.processDone = processDone
	c.tempDir = tempDir
	c.mu.Unlock()
	go c.captureStderr(stderr)
	go func() { processDone <- cmd.Wait(); close(processDone) }()
	boot, err := c.waitBootstrap(startCtx, bootstrapPath, token, processDone)
	if err != nil {
		c.closeOwned()
		return err
	}
	address := net.JoinHostPort(boot.Host, strconv.Itoa(boot.Port))
	dialCtx, dialCancel := context.WithCancel(context.Background())
	conn, err := grpc.DialContext(startCtx, address, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithBlock(), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMessageBytes), grpc.MaxCallSendMsgSize(maxMessageBytes)))
	if err != nil {
		dialCancel()
		c.closeOwned()
		return fmt.Errorf("connect to omp gRPC endpoint: %w", err)
	}
	authCtx := metadata.AppendToOutgoingContext(dialCtx, "authorization", "Bearer "+boot.Token)
	stream, err := omprpcv1.NewAgentServiceClient(conn).Connect(authCtx, grpc.WaitForReady(true))
	if err != nil {
		dialCancel()
		conn.Close()
		c.closeOwned()
		return fmt.Errorf("open omp RPC stream: %w", err)
	}
	readyResult := make(chan firstFrameResult, 1)
	go func() {
		frame, receiveErr := stream.Recv()
		readyResult <- firstFrameResult{frame: frame, err: receiveErr}
	}()
	var first *omprpcv1.ServerFrame
	select {
	case result := <-readyResult:
		first, err = result.frame, result.err
	case <-startCtx.Done():
		dialCancel()
		conn.Close()
		c.closeOwned()
		return &TimeoutError{Operation: "wait for gRPC Ready", Err: startCtx.Err()}
	}
	if err != nil {
		dialCancel()
		conn.Close()
		c.closeOwned()
		return fmt.Errorf("receive ready frame: %w", err)
	}
	ready := first.GetReady()
	if ready == nil {
		dialCancel()
		conn.Close()
		c.closeOwned()
		return errors.New("first gRPC server frame must be ready")
	}
	if ready.ProtocolVersion != protocolVersion {
		dialCancel()
		conn.Close()
		c.closeOwned()
		return fmt.Errorf("unsupported gRPC protocol version %d", ready.ProtocolVersion)
	}
	if ready.MaxMessageBytes != maxMessageBytes {
		dialCancel()
		conn.Close()
		c.closeOwned()
		return fmt.Errorf("unsupported gRPC message size %d", ready.MaxMessageBytes)
	}
	c.mu.Lock()
	c.conn = conn
	c.stream = stream
	c.cancel = dialCancel
	c.mu.Unlock()
	c.dispatch(ReadyEvent{ProtocolVersion: ready.ProtocolVersion, MaxMessageBytes: ready.MaxMessageBytes})
	go c.receiveLoop()
	if len(c.hostTools) != 0 {
		tools := make([]HostTool, 0, len(c.hostTools))
		for _, tool := range c.hostTools {
			tools = append(tools, tool)
		}
		if _, err = c.SetCustomTools(ctx, tools); err != nil {
			c.closeOwned()
			return err
		}
	}
	if len(c.hostURIs) != 0 {
		uris := make([]HostURI, 0, len(c.hostURIs))
		for _, uri := range c.hostURIs {
			uris = append(uris, uri)
		}
		if _, err = c.SetHostURIs(ctx, uris); err != nil {
			c.closeOwned()
			return err
		}
	}
	return nil
}

func (c *Client) waitBootstrap(ctx context.Context, path, token string, processDone <-chan error) (bootstrap, error) {
	var boot bootstrap
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		raw, err := os.ReadFile(path)
		if err == nil {
			if err = json.Unmarshal(raw, &boot); err != nil {
				return boot, fmt.Errorf("decode gRPC bootstrap: %w", err)
			}
			if boot.Protocol != "grpc" || boot.ProtocolVersion != protocolVersion || boot.Host != "127.0.0.1" || boot.Port < 1 || boot.Port > 65535 || boot.Token != token || boot.MaxMessageBytes != maxMessageBytes {
				return boot, errors.New("invalid or unsupported gRPC bootstrap")
			}
			return boot, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return boot, fmt.Errorf("read gRPC bootstrap: %w", err)
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return boot, &TimeoutError{Operation: "wait for gRPC bootstrap", Err: ctx.Err()}
			}
			return boot, ctx.Err()
		case processErr := <-processDone:
			return boot, &ProcessExitError{Err: fmt.Errorf("exited before publishing gRPC endpoint: %v; stderr: %s", processErr, c.Stderr())}
		case <-ticker.C:
		}
	}
}

func (c *Client) receiveLoop() {
	for {
		c.mu.Lock()
		stream := c.stream
		c.mu.Unlock()
		if stream == nil {
			return
		}
		frame, err := stream.Recv()
		if err != nil {
			failure := &ProcessExitError{Err: err}
			c.failAll(failure)
			go c.closeOwned()
			return
		}
		if frame.GetReady() != nil {
			protocolErr := &ProtocolError{Message: "gRPC server sent more than one ready frame"}
			c.recordProtocol(protocolErr)
			c.failAll(protocolErr)
			return
		}
		if response := frame.GetResponse(); response != nil {
			c.handleResponse(response)
			continue
		}
		if push := frame.GetPush(); push != nil {
			c.handlePush(push.Type, push.PayloadJson)
			continue
		}
		c.recordProtocol(&ProtocolError{Message: "gRPC server sent an empty frame"})
	}
}

func (c *Client) request(ctx context.Context, command string, payload any) (json.RawMessage, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.cfg.RequestTimeout)
		defer cancel()
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode %s request: %w", command, err)
	}
	if len(raw) > maxMessageBytes {
		return nil, errors.New("RPC payload exceeds the gRPC message size limit")
	}
	id := fmt.Sprintf("req_%d", c.requestID.Add(1))
	result := make(chan responseResult, 1)
	c.mu.Lock()
	if c.stream == nil {
		c.mu.Unlock()
		return nil, errors.New("omp RPC client is not started")
	}
	c.pending[id] = pendingResponse{command: command, ch: result}
	stream := c.stream
	c.mu.Unlock()
	c.sendMu.Lock()
	sendErr := stream.Send(&omprpcv1.ClientFrame{Frame: &omprpcv1.ClientFrame_Command{Command: &omprpcv1.Command{Id: id, Name: command, PayloadJson: raw, HasId: true}}})
	c.sendMu.Unlock()
	if sendErr != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("send %s request: %w", command, sendErr)
	}
	select {
	case response := <-result:
		return response.raw, response.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, &TimeoutError{Operation: command + " response", Err: ctx.Err()}
		}
		return nil, ctx.Err()
	case <-c.closed:
		return nil, errors.New("omp RPC client closed")
	}
}

// RequestRaw sends a raw command and decodes its object result.
func (c *Client) RequestRaw(ctx context.Context, command string, payload JSON) (JSON, error) {
	raw, err := c.request(ctx, command, omitNil(payload))
	if err != nil {
		return nil, err
	}
	var result JSON
	if err = decodeResult(raw, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// Request is an alias for RequestRaw.
func (c *Client) Request(ctx context.Context, command string, payload JSON) (JSON, error) {
	return c.RequestRaw(ctx, command, payload)
}

func omitNil(payload JSON) JSON {
	result := make(JSON, len(payload))
	for key, value := range payload {
		if value != nil {
			result[key] = value
		}
	}
	return result
}

func (c *Client) handleResponse(response *omprpcv1.Response) {
	payload := JSON{"type": "response", "command": response.Command, "success": response.Success}
	if response.HasId {
		payload["id"] = response.Id
	}
	if response.HasCode {
		payload["code"] = response.Code
	}
	if response.HasError {
		payload["error"] = response.Error
	}

	c.mu.Lock()
	pending, found := c.pending[response.Id]
	if found {
		delete(c.pending, response.Id)
	}
	if !found && !response.Success {
		var matchID string
		for id, candidate := range c.pending {
			if candidate.command == response.Command {
				if matchID != "" {
					matchID = ""
					break
				}
				matchID = id
			}
		}
		if matchID == "" && response.Command == "parse" && len(c.pending) == 1 {
			for id := range c.pending {
				matchID = id
			}
		}
		if matchID != "" {
			pending = c.pending[matchID]
			delete(c.pending, matchID)
			found = true
		}
	}
	c.mu.Unlock()

	if !found {
		if !response.Success && (response.Command == "prompt" || response.Command == "abort_and_prompt") {
			c.mu.Lock()
			c.asyncErr = &CommandError{Command: response.Command, Message: response.Error, Code: response.Code, HasCode: response.HasCode}
			c.completed++
			c.mu.Unlock()
			select {
			case c.eventSignal <- struct{}{}:
			default:
			}
		}
		c.recordProtocol(&ProtocolError{Message: "uncorrelated RPC response", Payload: payload})
		return
	}
	if pending.command != response.Command {
		err := &ProtocolError{Message: fmt.Sprintf("RPC response command mismatch: expected %q, received %q", pending.command, response.Command), Payload: payload}
		c.recordProtocol(err)
		pending.ch <- responseResult{err: err}
		return
	}
	if !response.Success {
		pending.ch <- responseResult{err: &CommandError{Command: response.Command, Message: response.Error, Code: response.Code, HasCode: response.HasCode}}
		return
	}
	if response.HasData {
		pending.ch <- responseResult{raw: append(json.RawMessage(nil), response.DataJson...)}
	} else {
		pending.ch <- responseResult{raw: json.RawMessage(`{}`)}
	}
}

func (c *Client) sendPush(kind string, body JSON) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if len(raw) > maxMessageBytes {
		return errors.New("RPC push exceeds the gRPC message size limit")
	}
	c.mu.Lock()
	stream := c.stream
	c.mu.Unlock()
	if stream == nil {
		return errors.New("omp RPC client is not started")
	}
	c.sendMu.Lock()
	err = stream.Send(&omprpcv1.ClientFrame{Frame: &omprpcv1.ClientFrame_Push{Push: &omprpcv1.Push{Type: kind, PayloadJson: raw}}})
	c.sendMu.Unlock()
	return err
}

func (c *Client) handlePush(kind string, raw []byte) {
	var body JSON
	if err := json.Unmarshal(raw, &body); err != nil {
		c.recordProtocol(&ProtocolError{Message: "invalid push JSON: " + err.Error()})
		return
	}
	if kind == "tool_execution_update" || kind == "tool_execution_end" {
		if callID, ok := body["toolCallId"].(string); ok {
			c.mu.Lock()
			hostName := c.hostToolDispatchNames[callID]
			if kind == "tool_execution_end" {
				delete(c.hostToolDispatchNames, callID)
			}
			c.mu.Unlock()
			if hostName != "" {
				body["toolName"] = hostName
				raw, _ = json.Marshal(body)
			}
		}
	}
	switch kind {
	case "host_tool_call":
		c.handleHostToolCall(body)
		return
	case "host_tool_cancel", "host_uri_cancel":
		if target, ok := body["targetId"].(string); ok {
			c.cancelCallback(target)
		}
		return
	case "host_uri_request":
		c.handleHostURIRequest(body)
		return
	}
	notification, err := decodeNotification(kind, raw)
	if err != nil {
		notification = UnknownNotification{eventBase: eventBase{Type: "unknown"}, Payload: body, ParseError: err.Error()}
		if kind == "agent_end" {
			c.mu.Lock()
			c.asyncErr = err
			c.completed++
			c.mu.Unlock()
			select {
			case c.eventSignal <- struct{}{}:
			default:
			}
		}
	}
	c.dispatch(notification)
	if ui, ok := notification.(*ExtensionUIRequest); ok {
		select {
		case c.uiRequests <- *ui:
		default:
			c.recordProtocol(&ProtocolError{Message: "extension UI request queue is full", Payload: body})
		}
		return
	}
	if event, ok := notification.(AgentEvent); ok {
		c.appendEvent(event)
	}
}

func (c *Client) appendEvent(event AgentEvent) {
	c.mu.Lock()
	index := c.eventOffset + uint64(len(c.events))
	c.events = append(c.events, indexedEvent{index: index, event: event})
	if end, ok := event.(*AgentEndEvent); ok && (end.IsTerminal == nil || *end.IsTerminal) {
		c.completed++
	}
	if c.cfg.MaxEventHistory > 0 && len(c.events) > c.cfg.MaxEventHistory {
		trim := len(c.events) - c.cfg.MaxEventHistory
		c.events = append([]indexedEvent(nil), c.events[trim:]...)
		c.eventOffset += uint64(trim)
	}
	c.mu.Unlock()
	select {
	case c.eventSignal <- struct{}{}:
	default:
	}
}

func (c *Client) captureStderr(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		c.mu.Lock()
		c.stderr = append(c.stderr, scanner.Text()+"\n")
		if c.cfg.MaxStderrChunks > 0 && len(c.stderr) > c.cfg.MaxStderrChunks {
			c.stderr = append([]string(nil), c.stderr[len(c.stderr)-c.cfg.MaxStderrChunks:]...)
		}
		c.mu.Unlock()
	}
}

// Stderr returns the bounded stderr history captured from omp.
func (c *Client) Stderr() string { c.mu.Lock(); defer c.mu.Unlock(); return strings.Join(c.stderr, "") }

// ProtocolErrors returns a snapshot of bounded protocol errors.
func (c *Client) ProtocolErrors() []*ProtocolError {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*ProtocolError(nil), c.protocolErrors...)
}

// ListenerErrors returns a snapshot of bounded recovered listener panics.
func (c *Client) ListenerErrors() []ListenerError {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ListenerError(nil), c.listenerErrors...)
}

func (c *Client) recordProtocol(err *ProtocolError) {
	c.mu.Lock()
	c.protocolErrors = append(c.protocolErrors, err)
	if c.cfg.ProtocolErrorHistory > 0 && len(c.protocolErrors) > c.cfg.ProtocolErrorHistory {
		c.protocolErrors = append([]*ProtocolError(nil), c.protocolErrors[len(c.protocolErrors)-c.cfg.ProtocolErrorHistory:]...)
	}
	listeners := make([]func(*ProtocolError), 0, len(c.protocolListeners))
	for _, listener := range c.protocolListeners {
		listeners = append(listeners, listener)
	}
	c.mu.Unlock()
	for _, listener := range listeners {
		current := listener
		c.callListener("protocol_error", "", func() { current(err) })
	}
}
func (c *Client) failAll(err error) {
	c.mu.Lock()
	pending := c.pending
	c.pending = make(map[string]pendingResponse)
	if c.asyncErr == nil {
		c.asyncErr = err
	}
	c.mu.Unlock()
	for _, request := range pending {
		request.ch <- responseResult{err: err}
	}
	select {
	case c.eventSignal <- struct{}{}:
	default:
	}
}

// OnNotification registers a listener and returns an idempotent unsubscribe function.
func (c *Client) OnNotification(listener Listener) func() {
	c.mu.Lock()
	c.nextListener++
	id := c.nextListener
	c.listeners[id] = listener
	c.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { c.mu.Lock(); delete(c.listeners, id); c.mu.Unlock() }) }
}

// OnEvent registers a listener for every agent lifecycle event.
func (c *Client) OnEvent(listener EventListener) func() {
	c.mu.Lock()
	c.nextListener++
	id := c.nextListener
	c.eventListeners[id] = listener
	c.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { c.mu.Lock(); delete(c.eventListeners, id); c.mu.Unlock() }) }
}

// OnEventType registers a listener for a specific event type.
func (c *Client) OnEventType(eventType string, listener EventListener) func() {
	c.mu.Lock()
	c.nextListener++
	id := c.nextListener
	if c.typedListeners[eventType] == nil {
		c.typedListeners[eventType] = make(map[uint64]EventListener)
	}
	c.typedListeners[eventType][id] = listener
	c.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { c.mu.Lock(); delete(c.typedListeners[eventType], id); c.mu.Unlock() }) }
}

func (c *Client) dispatch(notification Notification) {
	c.mu.Lock()
	listeners := make([]Listener, 0, len(c.listeners))
	for _, listener := range c.listeners {
		listeners = append(listeners, listener)
	}
	var events []EventListener
	if _, ok := notification.(AgentEvent); ok {
		for _, listener := range c.eventListeners {
			events = append(events, listener)
		}
		for _, listener := range c.typedListeners[notification.EventType()] {
			events = append(events, listener)
		}
	}
	c.mu.Unlock()
	for _, listener := range listeners {
		c.callListener("notification", notification.EventType(), func() { listener(notification) })
	}
	if event, ok := notification.(AgentEvent); ok {
		for _, listener := range events {
			current := listener
			c.callListener("event", notification.EventType(), func() { current(event) })
		}
	}
}

func (c *Client) callListener(kind, source string, call func()) {
	defer func() {
		if recovered := recover(); recovered != nil {
			c.recordListenerError(ListenerError{Kind: kind, SourceType: source, Panic: recovered})
		}
	}()
	call()
}
func (c *Client) recordListenerError(event ListenerError) {
	c.mu.Lock()
	c.listenerErrors = append(c.listenerErrors, event)
	if c.cfg.ListenerErrorHistory > 0 && len(c.listenerErrors) > c.cfg.ListenerErrorHistory {
		c.listenerErrors = append([]ListenerError(nil), c.listenerErrors[len(c.listenerErrors)-c.cfg.ListenerErrorHistory:]...)
	}
	listeners := make([]func(ListenerError), 0, len(c.listenerErrorListeners))
	for _, listener := range c.listenerErrorListeners {
		listeners = append(listeners, listener)
	}
	c.mu.Unlock()
	for _, listener := range listeners {
		func() { defer func() { _ = recover() }(); listener(event) }()
	}
}

// Close closes the stream, cancels callbacks, terminates the whole omp process tree, and unblocks waiters.
func (c *Client) Close() error {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	return c.closeOwned()
}

// Stop is an alias for Close.
func (c *Client) Stop() error { return c.Close() }

func (c *Client) closeOwned() error {
	var closeErr error
	c.closeOnce.Do(func() {
		close(c.closed)
		c.mu.Lock()
		cancel := c.cancel
		stream := c.stream
		conn := c.conn
		cmd := c.cmd
		tree := c.tree
		done := c.processDone
		tempDir := c.tempDir
		callbacks := c.callbackCancels
		c.callbackCancels = make(map[string]context.CancelFunc)
		c.stream = nil
		c.conn = nil
		c.tree = nil
		c.mu.Unlock()
		for _, callbackCancel := range callbacks {
			callbackCancel()
		}
		callbackDone := make(chan struct{})
		go func() { c.callbackWG.Wait(); close(callbackDone) }()
		select {
		case <-callbackDone:
		case <-time.After(2 * time.Second):
		}
		c.failAll(errors.New("omp RPC client closed"))
		if cancel != nil {
			cancel()
		}
		if stream != nil {
			c.sendMu.Lock()
			_ = stream.CloseSend()
			c.sendMu.Unlock()
		}
		if conn != nil {
			_ = conn.Close()
		}
		if cmd != nil && cmd.Process != nil {
			closeErr = terminateProcessTree(cmd, tree)
		}
		if done != nil {
			select {
			case <-done:
			case <-time.After(3 * time.Second):
			}
		}
		if tempDir != "" {
			_ = os.RemoveAll(tempDir)
		}
	})
	return closeErr
}
