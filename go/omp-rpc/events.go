package omprpc

import (
	"encoding/json"
	"fmt"
)

// Notification is a typed server push notification.
type Notification interface{ EventType() string }

// AgentEvent is a notification emitted by the agent lifecycle.
type AgentEvent interface {
	Notification
	isAgentEvent()
}

type eventBase struct {
	Type string `json:"type"`
}

func (e eventBase) EventType() string { return e.Type }

type agentEventBase struct{ eventBase }

func (agentEventBase) isAgentEvent() {}

// ReadyEvent describes the negotiated wire protocol.
type ReadyEvent struct {
	ProtocolVersion uint32
	MaxMessageBytes uint64
}

func (ReadyEvent) EventType() string { return "ready" }

// AgentStartEvent marks the start of an agent run.
type AgentStartEvent struct{ agentEventBase }

// AgentEndEvent marks the completion of an agent run.
type AgentEndEvent struct {
	agentEventBase
	Messages     []AgentMessage `json:"messages"`
	MessageCount *int           `json:"messageCount"`
	IsTerminal   *bool          `json:"isTerminal"`
}

// TurnStartEvent marks the start of an agent turn.
type TurnStartEvent struct{ agentEventBase }

// TurnEndEvent contains the final message and tool results for a turn.
type TurnEndEvent struct {
	agentEventBase
	Message     AgentMessage   `json:"message"`
	ToolResults []AgentMessage `json:"toolResults"`
}

// MessageStartEvent marks message streaming start.
type MessageStartEvent struct {
	agentEventBase
	Message AgentMessage `json:"message"`
}

// MessageUpdateEvent carries a message streaming update.
type MessageUpdateEvent struct {
	agentEventBase
	Message               AgentMessage `json:"message"`
	AssistantMessageEvent JSON         `json:"assistantMessageEvent"`
}

// MessageEndEvent marks message streaming completion.
type MessageEndEvent struct {
	agentEventBase
	Message AgentMessage `json:"message"`
}

// ToolExecutionStartEvent describes a starting tool call.
type ToolExecutionStartEvent struct {
	agentEventBase
	ToolCallID string  `json:"toolCallId"`
	ToolName   string  `json:"toolName"`
	Args       any     `json:"args"`
	Intent     *string `json:"intent"`
}

// ToolExecutionUpdateEvent carries a partial tool result.
type ToolExecutionUpdateEvent struct {
	agentEventBase
	ToolCallID    string `json:"toolCallId"`
	ToolName      string `json:"toolName"`
	Args          any    `json:"args"`
	PartialResult any    `json:"partialResult"`
}

// ToolExecutionEndEvent contains a completed tool result.
type ToolExecutionEndEvent struct {
	agentEventBase
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Result     any    `json:"result"`
	IsError    *bool  `json:"isError"`
}

// AutoCompactionStartEvent reports automatic compaction start.
type AutoCompactionStartEvent struct {
	agentEventBase
	Reason string `json:"reason"`
	Action string `json:"action"`
}

// AutoCompactionEndEvent reports automatic compaction completion.
type AutoCompactionEndEvent struct {
	agentEventBase
	Action       string            `json:"action"`
	Result       *CompactionResult `json:"result"`
	Aborted      bool              `json:"aborted"`
	WillRetry    bool              `json:"willRetry"`
	ErrorMessage *string           `json:"errorMessage"`
	Skipped      *bool             `json:"skipped"`
}

// AutoRetryStartEvent reports an automatic retry attempt.
type AutoRetryStartEvent struct {
	agentEventBase
	Attempt      int    `json:"attempt"`
	MaxAttempts  int    `json:"maxAttempts"`
	DelayMS      int    `json:"delayMs"`
	ErrorMessage string `json:"errorMessage"`
}

// AutoRetryEndEvent reports automatic retry completion.
type AutoRetryEndEvent struct {
	agentEventBase
	Success    bool    `json:"success"`
	Attempt    int     `json:"attempt"`
	FinalError *string `json:"finalError"`
}

// RetryFallbackAppliedEvent reports a model fallback.
type RetryFallbackAppliedEvent struct {
	agentEventBase
	FromModel string `json:"from"`
	ToModel   string `json:"to"`
	Role      string `json:"role"`
}

// RetryFallbackSucceededEvent reports successful fallback use.
type RetryFallbackSucceededEvent struct {
	agentEventBase
	Model string `json:"model"`
	Role  string `json:"role"`
}

// TTSRTriggeredEvent reports triggered time-to-self-reflect rules.
type TTSRTriggeredEvent struct {
	agentEventBase
	Rules []JSON `json:"rules"`
}

// TodoReminderEvent reports a todo reminder attempt.
type TodoReminderEvent struct {
	agentEventBase
	Todos       []TodoItem `json:"todos"`
	Attempt     int        `json:"attempt"`
	MaxAttempts int        `json:"maxAttempts"`
}

// TodoAutoClearEvent reports automatic todo clearing.
type TodoAutoClearEvent struct{ agentEventBase }

// ExtensionUIRequest is an extension interaction request.
type ExtensionUIRequest struct {
	eventBase
	ID              string   `json:"id"`
	Method          string   `json:"method"`
	Title           *string  `json:"title"`
	Options         []string `json:"options"`
	Message         *string  `json:"message"`
	Placeholder     *string  `json:"placeholder"`
	Prefill         *string  `json:"prefill"`
	Timeout         *int     `json:"timeout"`
	PromptStyle     *bool    `json:"promptStyle"`
	TargetID        *string  `json:"targetId"`
	NotifyType      *string  `json:"notifyType"`
	StatusKey       *string  `json:"statusKey"`
	StatusText      *string  `json:"statusText"`
	WidgetKey       *string  `json:"widgetKey"`
	WidgetLines     []string `json:"widgetLines"`
	WidgetPlacement *string  `json:"widgetPlacement"`
	Text            *string  `json:"text"`
	URL             *string  `json:"url"`
	LaunchURL       *string  `json:"launchUrl"`
	Instructions    *string  `json:"instructions"`
}

// IsPassive reports whether the request requires no response.
func (r ExtensionUIRequest) IsPassive() bool {
	switch r.Method {
	case "notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url":
		return true
	}
	return false
}

// IsInteractive reports whether the request needs a host response.
func (r ExtensionUIRequest) IsInteractive() bool {
	return r.Method == "select" || r.Method == "confirm" || r.Method == "input" || r.Method == "editor"
}

// AcceptsText reports whether the request accepts a text value.
func (r ExtensionUIRequest) AcceptsText() bool {
	return r.Method == "select" || r.Method == "input" || r.Method == "editor"
}

// RequiresResponse reports whether the request requires a host response.
func (r ExtensionUIRequest) RequiresResponse() bool { return r.IsInteractive() }

// ExtensionError is an extension callback failure.
type ExtensionError struct {
	eventBase
	ExtensionPath string `json:"extensionPath"`
	Event         string `json:"event"`
	ErrorMessage  string `json:"error"`
}

// UnknownNotification preserves an unrecognized or malformed push body.
type UnknownNotification struct {
	eventBase
	Payload    JSON
	ParseError string
}

func (u UnknownNotification) EventType() string { return "unknown" }

func decodeNotification(kind string, raw []byte) (Notification, error) {
	constructors := map[string]func() Notification{
		"agent_start":              func() Notification { return &AgentStartEvent{} },
		"agent_end":                func() Notification { return &AgentEndEvent{} },
		"turn_start":               func() Notification { return &TurnStartEvent{} },
		"turn_end":                 func() Notification { return &TurnEndEvent{} },
		"message_start":            func() Notification { return &MessageStartEvent{} },
		"message_update":           func() Notification { return &MessageUpdateEvent{} },
		"message_end":              func() Notification { return &MessageEndEvent{} },
		"tool_execution_start":     func() Notification { return &ToolExecutionStartEvent{} },
		"tool_execution_update":    func() Notification { return &ToolExecutionUpdateEvent{} },
		"tool_execution_end":       func() Notification { return &ToolExecutionEndEvent{} },
		"auto_compaction_start":    func() Notification { return &AutoCompactionStartEvent{} },
		"auto_compaction_end":      func() Notification { return &AutoCompactionEndEvent{} },
		"auto_retry_start":         func() Notification { return &AutoRetryStartEvent{} },
		"auto_retry_end":           func() Notification { return &AutoRetryEndEvent{} },
		"retry_fallback_applied":   func() Notification { return &RetryFallbackAppliedEvent{} },
		"retry_fallback_succeeded": func() Notification { return &RetryFallbackSucceededEvent{} },
		"ttsr_triggered":           func() Notification { return &TTSRTriggeredEvent{} },
		"todo_reminder":            func() Notification { return &TodoReminderEvent{} },
		"todo_auto_clear":          func() Notification { return &TodoAutoClearEvent{} },
		"extension_ui_request":     func() Notification { return &ExtensionUIRequest{} },
		"extension_error":          func() Notification { return &ExtensionError{} },
	}
	ctor := constructors[kind]
	if ctor == nil {
		var payload JSON
		if err := json.Unmarshal(raw, &payload); err != nil {
			return UnknownNotification{eventBase: eventBase{Type: "unknown"}, Payload: JSON{}, ParseError: err.Error()}, nil
		}
		payload["type"] = kind
		return UnknownNotification{eventBase: eventBase{Type: "unknown"}, Payload: payload}, nil
	}
	value := ctor()
	if err := json.Unmarshal(raw, value); err != nil {
		return nil, fmt.Errorf("decode %s notification: %w", kind, err)
	}
	switch event := value.(type) {
	case *AgentStartEvent:
		event.Type = kind
	case *AgentEndEvent:
		event.Type = kind
	case *TurnStartEvent:
		event.Type = kind
	case *TurnEndEvent:
		event.Type = kind
	case *MessageStartEvent:
		event.Type = kind
	case *MessageUpdateEvent:
		event.Type = kind
	case *MessageEndEvent:
		event.Type = kind
	case *ToolExecutionStartEvent:
		event.Type = kind
	case *ToolExecutionUpdateEvent:
		event.Type = kind
	case *ToolExecutionEndEvent:
		event.Type = kind
	case *AutoCompactionStartEvent:
		event.Type = kind
	case *AutoCompactionEndEvent:
		event.Type = kind
	case *AutoRetryStartEvent:
		event.Type = kind
	case *AutoRetryEndEvent:
		event.Type = kind
	case *RetryFallbackAppliedEvent:
		event.Type = kind
	case *RetryFallbackSucceededEvent:
		event.Type = kind
	case *TTSRTriggeredEvent:
		event.Type = kind
	case *TodoReminderEvent:
		event.Type = kind
	case *TodoAutoClearEvent:
		event.Type = kind
	case *ExtensionUIRequest:
		event.Type = kind
	case *ExtensionError:
		event.Type = kind
	}
	return value, nil
}
