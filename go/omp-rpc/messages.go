package omprpc

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// ContentBlock is a typed message content block. Arguments and Extra preserve tool/provider extensions.
type ContentBlock struct {
	Type              string `json:"type"`
	Text              string `json:"text,omitempty"`
	TextSignature     string `json:"textSignature,omitempty"`
	Thinking          string `json:"thinking,omitempty"`
	ThinkingSignature string `json:"thinkingSignature,omitempty"`
	Data              string `json:"data,omitempty"`
	MimeType          string `json:"mimeType,omitempty"`
	ID                string `json:"id,omitempty"`
	Name              string `json:"name,omitempty"`
	Arguments         JSON   `json:"arguments,omitempty"`
	ThoughtSignature  string `json:"thoughtSignature,omitempty"`
	Intent            string `json:"intent,omitempty"`
}

// MessageContent represents either scalar text or a typed content-block list.
type MessageContent struct {
	Text   *string
	Blocks []ContentBlock
}

// UnmarshalJSON decodes either supported content representation.
func (c *MessageContent) UnmarshalJSON(data []byte) error {
	if bytes.Equal(data, []byte("null")) {
		return nil
	}
	if len(data) != 0 && data[0] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		c.Text = &text
		c.Blocks = nil
		return nil
	}
	c.Text = nil
	if err := json.Unmarshal(data, &c.Blocks); err != nil {
		return fmt.Errorf("message content must be a string or content-block array: %w", err)
	}
	return nil
}

// MarshalJSON preserves the scalar-or-block wire representation.
func (c MessageContent) MarshalJSON() ([]byte, error) {
	if c.Text != nil {
		return json.Marshal(*c.Text)
	}
	if c.Blocks == nil {
		return []byte("null"), nil
	}
	return json.Marshal(c.Blocks)
}

// UsageCost contains stable assistant-message cost details.
type UsageCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// MessageUsage contains assistant-message token and request usage.
type MessageUsage struct {
	Input           int       `json:"input"`
	Output          int       `json:"output"`
	CacheRead       int       `json:"cacheRead"`
	CacheWrite      int       `json:"cacheWrite"`
	TotalTokens     int       `json:"totalTokens"`
	PremiumRequests *int      `json:"premiumRequests,omitempty"`
	Cost            UsageCost `json:"cost"`
}

// FileMentionItem describes a file attached to a fileMention message.
type FileMentionItem struct {
	Path          string        `json:"path"`
	Content       string        `json:"content"`
	LineCount     *int          `json:"lineCount,omitempty"`
	ByteSize      *int          `json:"byteSize,omitempty"`
	SkippedReason *string       `json:"skippedReason,omitempty"`
	Image         *ImageContent `json:"image,omitempty"`
}

// AgentMessage is the typed envelope shared by every transcript message role.
// Unknown retains role-specific provider extensions without weakening stable fields.
type AgentMessage struct {
	Role               string            `json:"role"`
	Content            MessageContent    `json:"content,omitempty"`
	Synthetic          *bool             `json:"synthetic,omitempty"`
	Attribution        string            `json:"attribution,omitempty"`
	ProviderPayload    JSON              `json:"providerPayload,omitempty"`
	Timestamp          int64             `json:"timestamp,omitempty"`
	API                string            `json:"api,omitempty"`
	Provider           string            `json:"provider,omitempty"`
	Model              string            `json:"model,omitempty"`
	ResponseID         string            `json:"responseId,omitempty"`
	Usage              *MessageUsage     `json:"usage,omitempty"`
	StopReason         string            `json:"stopReason,omitempty"`
	ErrorMessage       string            `json:"errorMessage,omitempty"`
	Duration           *int              `json:"duration,omitempty"`
	TTFT               *int              `json:"ttft,omitempty"`
	ToolCallID         string            `json:"toolCallId,omitempty"`
	ToolName           string            `json:"toolName,omitempty"`
	Details            any               `json:"details,omitempty"`
	IsError            *bool             `json:"isError,omitempty"`
	PrunedAt           *int64            `json:"prunedAt,omitempty"`
	Command            string            `json:"command,omitempty"`
	Code               string            `json:"code,omitempty"`
	Output             string            `json:"output,omitempty"`
	ExitCode           *int              `json:"exitCode,omitempty"`
	Cancelled          *bool             `json:"cancelled,omitempty"`
	Truncated          *bool             `json:"truncated,omitempty"`
	Meta               JSON              `json:"meta,omitempty"`
	ExcludeFromContext *bool             `json:"excludeFromContext,omitempty"`
	CustomType         string            `json:"customType,omitempty"`
	Display            *bool             `json:"display,omitempty"`
	Summary            string            `json:"summary,omitempty"`
	FromID             string            `json:"fromId,omitempty"`
	ShortSummary       string            `json:"shortSummary,omitempty"`
	TokensBefore       *int              `json:"tokensBefore,omitempty"`
	Files              []FileMentionItem `json:"files,omitempty"`
	Unknown            JSON              `json:"-"`
}

// UnmarshalJSON decodes stable union fields and retains unknown extensions.
func (m *AgentMessage) UnmarshalJSON(data []byte) error {
	type alias AgentMessage
	if err := json.Unmarshal(data, (*alias)(m)); err != nil {
		return err
	}
	var unknown JSON
	if err := json.Unmarshal(data, &unknown); err != nil {
		return err
	}
	for _, key := range []string{"role", "content", "synthetic", "attribution", "providerPayload", "timestamp", "api", "provider", "model", "responseId", "usage", "stopReason", "errorMessage", "duration", "ttft", "toolCallId", "toolName", "details", "isError", "prunedAt", "command", "code", "output", "exitCode", "cancelled", "truncated", "meta", "excludeFromContext", "customType", "display", "summary", "fromId", "shortSummary", "tokensBefore", "files"} {
		delete(unknown, key)
	}
	m.Unknown = unknown
	return nil
}
