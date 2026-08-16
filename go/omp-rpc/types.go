package omprpc

import (
	"encoding/json"
	"errors"
	"fmt"
)

// JSON is a dynamic JSON object used where the RPC protocol intentionally has an open schema.
type JSON map[string]any

// ImageContent is an inline image accepted by prompt commands.
type ImageContent struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

// ModelCost describes a model's per-token costs.
type ModelCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// ThinkingConfig describes the reasoning controls supported by a model.
type ThinkingConfig struct {
	Mode            string            `json:"mode"`
	Efforts         []string          `json:"efforts"`
	DefaultLevel    *string           `json:"defaultLevel,omitempty"`
	EffortMap       map[string]string `json:"effortMap,omitempty"`
	SupportsDisplay *bool             `json:"supportsDisplay,omitempty"`
	EffortRouting   map[string]string `json:"effortRouting,omitempty"`
	SuppressWhenOff *bool             `json:"suppressWhenOff,omitempty"`
	RequiresEffort  *bool             `json:"requiresEffort,omitempty"`
}

// ModelInfo is the stable model descriptor returned by model commands.
type ModelInfo struct {
	ID                     string            `json:"id"`
	Name                   string            `json:"name"`
	API                    string            `json:"api"`
	Provider               string            `json:"provider"`
	BaseURL                string            `json:"baseUrl"`
	Reasoning              bool              `json:"reasoning"`
	InputModalities        []string          `json:"input"`
	Cost                   ModelCost         `json:"cost"`
	ContextWindow          int               `json:"contextWindow"`
	MaxTokens              int               `json:"maxTokens"`
	Headers                map[string]string `json:"headers,omitempty"`
	PremiumMultiplier      *float64          `json:"premiumMultiplier,omitempty"`
	PreferWebsockets       *bool             `json:"preferWebsockets,omitempty"`
	ContextPromotionTarget *string           `json:"contextPromotionTarget,omitempty"`
	Priority               *int              `json:"priority,omitempty"`
	Thinking               *ThinkingConfig   `json:"thinking,omitempty"`
	Compat                 JSON              `json:"compat,omitempty"`
}

// ToolDescriptor describes a tool mounted in the current session.
type ToolDescriptor struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

// TodoItem is a task in a todo phase.
type TodoItem struct {
	ID      string  `json:"id,omitempty"`
	Content string  `json:"content"`
	Status  string  `json:"status"`
	Notes   *string `json:"notes,omitempty"`
	Details *string `json:"details,omitempty"`
	Blocker *string `json:"blocker,omitempty"`
}

// TodoPhase groups related todo tasks.
type TodoPhase struct {
	ID    string     `json:"id,omitempty"`
	Name  string     `json:"name"`
	Tasks []TodoItem `json:"tasks"`
}

// ContextUsage reports current context-window consumption.
type ContextUsage struct {
	Tokens        int     `json:"tokens"`
	ContextWindow int     `json:"contextWindow"`
	Percent       float64 `json:"percent"`
}

// RuntimeMetrics reports the owned omp process and V8 memory footprint.
type RuntimeMetrics struct {
	PID                 int     `json:"pid"`
	UptimeMS            float64 `json:"uptimeMs"`
	ResidentMemoryBytes int     `json:"residentMemoryBytes"`
	HeapUsedBytes       int     `json:"heapUsedBytes"`
	HeapTotalBytes      int     `json:"heapTotalBytes"`
	ExternalMemoryBytes int     `json:"externalMemoryBytes"`
}

// SessionState is the stable result of GetState.
type SessionState struct {
	Model                 *ModelInfo       `json:"model"`
	ThinkingLevel         *string          `json:"thinkingLevel"`
	IsStreaming           bool             `json:"isStreaming"`
	IsCompacting          bool             `json:"isCompacting"`
	SteeringMode          string           `json:"steeringMode"`
	FollowUpMode          string           `json:"followUpMode"`
	InterruptMode         string           `json:"interruptMode"`
	SessionFile           *string          `json:"sessionFile"`
	SessionID             string           `json:"sessionId"`
	SessionName           *string          `json:"sessionName"`
	AutoCompactionEnabled bool             `json:"autoCompactionEnabled"`
	MessageCount          int              `json:"messageCount"`
	QueuedMessageCount    int              `json:"queuedMessageCount"`
	TodoPhases            []TodoPhase      `json:"todoPhases"`
	SystemPrompt          []string         `json:"systemPrompt"`
	DumpTools             []ToolDescriptor `json:"dumpTools"`
	FastModeEnabled       bool             `json:"fastModeEnabled"`
	FastModeActive        bool             `json:"fastModeActive"`
	TokensPerSecond       *float64         `json:"tokensPerSecond"`
	ContextUsage          *ContextUsage    `json:"contextUsage"`
	Runtime               *RuntimeMetrics  `json:"runtime"`
}

// BashResult is the stable result of Bash.
type BashResult struct {
	Output      string  `json:"output"`
	ExitCode    *int    `json:"exitCode"`
	Cancelled   bool    `json:"cancelled"`
	Truncated   bool    `json:"truncated"`
	TotalLines  int     `json:"totalLines"`
	TotalBytes  int     `json:"totalBytes"`
	OutputLines int     `json:"outputLines"`
	OutputBytes int     `json:"outputBytes"`
	ArtifactID  *string `json:"artifactId"`
}

// FastModeResult is the stable result of SetFastMode.
type FastModeResult struct {
	Enabled bool `json:"enabled"`
	Active  bool `json:"active"`
}

// CompactionResult is the stable result of Compact.
type CompactionResult struct {
	Summary          string  `json:"summary"`
	ShortSummary     *string `json:"shortSummary"`
	FirstKeptEntryID string  `json:"firstKeptEntryId"`
	TokensBefore     int     `json:"tokensBefore"`
	Details          any     `json:"details,omitempty"`
	PreserveData     JSON    `json:"preserveData,omitempty"`
}

// ModelCycleResult is the stable result of CycleModel.
type ModelCycleResult struct {
	Model         ModelInfo `json:"model"`
	ThinkingLevel *string   `json:"thinkingLevel"`
	IsScoped      bool      `json:"isScoped"`
}

// ThinkingLevelCycleResult is the stable result of CycleThinkingLevel.
type ThinkingLevelCycleResult struct {
	Level string `json:"level"`
}

// CancellationResult describes whether a session operation cancelled active work.
type CancellationResult struct {
	Cancelled bool `json:"cancelled"`
}

// BranchMessage is an entry eligible as a branch point.
type BranchMessage struct {
	EntryID string `json:"entryId"`
	Text    string `json:"text"`
}

// BranchResult is the stable result of Branch.
type BranchResult struct {
	Text      string `json:"text"`
	Cancelled bool   `json:"cancelled"`
}

// TokenUsage contains cumulative session token counts.
type TokenUsage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

// SessionStats is the stable result of GetSessionStats.
type SessionStats struct {
	SessionFile       *string    `json:"sessionFile"`
	SessionID         string     `json:"sessionId"`
	UserMessages      int        `json:"userMessages"`
	AssistantMessages int        `json:"assistantMessages"`
	ToolCalls         int        `json:"toolCalls"`
	ToolResults       int        `json:"toolResults"`
	TotalMessages     int        `json:"totalMessages"`
	Tokens            TokenUsage `json:"tokens"`
	PremiumRequests   int        `json:"premiumRequests"`
	Cost              float64    `json:"cost"`
}

// MessagesPage is one cursor-paginated transcript page.
type MessagesPage struct {
	Messages      []AgentMessage `json:"messages"`
	TotalMessages int            `json:"totalMessages"`
	NextCursor    *string        `json:"nextCursor"`
}

// PromptTurn contains the events and final messages produced by PromptAndWait.
type PromptTurn struct {
	Events           []AgentEvent
	Messages         []AgentMessage
	AssistantMessage *AgentMessage
	AssistantText    string
	HasAssistantText bool
}

// RequireAssistantText returns assistant text or an error when the turn produced none.
func (t PromptTurn) RequireAssistantText() (string, error) {
	if !t.HasAssistantText {
		return "", errors.New("prompt completed without a text assistant message")
	}
	return t.AssistantText, nil
}

// CommandError is returned when the server rejects a command.
type CommandError struct {
	Command string
	Message string
	Code    string
	HasCode bool
}

func (e *CommandError) Error() string {
	if e.HasCode {
		return fmt.Sprintf("%s: %s (%s)", e.Command, e.Message, e.Code)
	}
	return fmt.Sprintf("%s: %s", e.Command, e.Message)
}

// TimeoutError reports a bounded SDK operation exceeding its context deadline.
type TimeoutError struct {
	Operation string
	Err       error
}

func (e *TimeoutError) Error() string { return fmt.Sprintf("%s: %v", e.Operation, e.Err) }
func (e *TimeoutError) Unwrap() error { return e.Err }

// ProcessExitError reports the owned process or stream exiting unexpectedly.
type ProcessExitError struct{ Err error }

func (e *ProcessExitError) Error() string { return "omp RPC process exited: " + e.Err.Error() }
func (e *ProcessExitError) Unwrap() error { return e.Err }

// ProtocolError reports an inconsistent, malformed, or uncorrelated wire frame.
type ProtocolError struct {
	Message string
	Payload JSON
}

func (e *ProtocolError) Error() string { return e.Message }

// ConcurrencyError reports overlapping prompt lifecycle collectors.
type ConcurrencyError struct {
	Active    string
	Requested string
}

func (e *ConcurrencyError) Error() string {
	return fmt.Sprintf("%s cannot run while %s is active", e.Requested, e.Active)
}

// ListenerError records a panic raised by an application listener.
type ListenerError struct {
	Kind       string
	SourceType string
	Panic      any
}

func decodeResult(raw json.RawMessage, out any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode RPC result: %w", err)
	}
	return nil
}
