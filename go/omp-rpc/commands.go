package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

func requestInto[T any](ctx context.Context, client *Client, command string, payload JSON) (T, error) {
	var result T
	raw, err := client.request(ctx, command, omitNil(payload))
	if err != nil {
		return result, err
	}
	if err = decodeResult(raw, &result); err != nil {
		return result, fmt.Errorf("%s: %w", command, err)
	}
	return result, nil
}

// GetState returns the current session state.
func (c *Client) GetState(ctx context.Context) (SessionState, error) {
	return requestInto[SessionState](ctx, c, "get_state", JSON{})
}

// SetFastMode enables or disables fast mode.
func (c *Client) SetFastMode(ctx context.Context, enabled bool) (FastModeResult, error) {
	return requestInto[FastModeResult](ctx, c, "set_fast_mode", JSON{"enabled": enabled})
}

// SetModel selects a provider model.
func (c *Client) SetModel(ctx context.Context, provider, modelID string) (ModelInfo, error) {
	return requestInto[ModelInfo](ctx, c, "set_model", JSON{"provider": provider, "modelId": modelID})
}

// CycleModel selects the next configured model. A nil result means no model was available.
func (c *Client) CycleModel(ctx context.Context) (*ModelCycleResult, error) {
	result, err := requestInto[*ModelCycleResult](ctx, c, "cycle_model", JSON{})
	return result, err
}

// GetAvailableModels returns every selectable model.
func (c *Client) GetAvailableModels(ctx context.Context) ([]ModelInfo, error) {
	result, err := requestInto[struct {
		Models []ModelInfo `json:"models"`
	}](ctx, c, "get_available_models", JSON{})
	return result.Models, err
}

// SetThinkingLevel selects an agent thinking level.
func (c *Client) SetThinkingLevel(ctx context.Context, level string) error {
	_, err := c.Request(ctx, "set_thinking_level", JSON{"level": level})
	return err
}

// CycleThinkingLevel selects the next thinking level.
func (c *Client) CycleThinkingLevel(ctx context.Context) (*ThinkingLevelCycleResult, error) {
	return requestInto[*ThinkingLevelCycleResult](ctx, c, "cycle_thinking_level", JSON{})
}

// SetSteeringMode configures queued steering behavior.
func (c *Client) SetSteeringMode(ctx context.Context, mode string) error {
	_, err := c.Request(ctx, "set_steering_mode", JSON{"mode": mode})
	return err
}

// SetFollowUpMode configures queued follow-up behavior.
func (c *Client) SetFollowUpMode(ctx context.Context, mode string) error {
	_, err := c.Request(ctx, "set_follow_up_mode", JSON{"mode": mode})
	return err
}

// SetInterruptMode configures prompt interruption behavior.
func (c *Client) SetInterruptMode(ctx context.Context, mode string) error {
	_, err := c.Request(ctx, "set_interrupt_mode", JSON{"mode": mode})
	return err
}

// Compact compacts the current session, optionally using custom instructions.
func (c *Client) Compact(ctx context.Context, customInstructions string) (CompactionResult, error) {
	payload := JSON{}
	if customInstructions != "" {
		payload["customInstructions"] = customInstructions
	}
	return requestInto[CompactionResult](ctx, c, "compact", payload)
}

// SetAutoCompaction enables or disables automatic compaction.
func (c *Client) SetAutoCompaction(ctx context.Context, enabled bool) error {
	_, err := c.Request(ctx, "set_auto_compaction", JSON{"enabled": enabled})
	return err
}

// SetAutoRetry enables or disables automatic retry.
func (c *Client) SetAutoRetry(ctx context.Context, enabled bool) error {
	_, err := c.Request(ctx, "set_auto_retry", JSON{"enabled": enabled})
	return err
}

// AbortRetry stops an active automatic retry.
func (c *Client) AbortRetry(ctx context.Context) error {
	_, err := c.Request(ctx, "abort_retry", JSON{})
	return err
}

// Bash executes a shell command in the agent session.
func (c *Client) Bash(ctx context.Context, command string) (BashResult, error) {
	return requestInto[BashResult](ctx, c, "bash", JSON{"command": command})
}

// AbortBash aborts the active Bash command.
func (c *Client) AbortBash(ctx context.Context) error {
	_, err := c.Request(ctx, "abort_bash", JSON{})
	return err
}

// GetSessionStats returns cumulative session statistics.
func (c *Client) GetSessionStats(ctx context.Context) (SessionStats, error) {
	return requestInto[SessionStats](ctx, c, "get_session_stats", JSON{})
}

// ExportHTML exports the transcript and returns its filesystem path.
func (c *Client) ExportHTML(ctx context.Context, outputPath string) (string, error) {
	result, err := requestInto[struct {
		Path string `json:"path"`
	}](ctx, c, "export_html", JSON{"outputPath": nilIfEmpty(outputPath)})
	return result.Path, err
}

// NewSession starts a new session, optionally linked to a parent session.
func (c *Client) NewSession(ctx context.Context, parentSession string) (CancellationResult, error) {
	return requestInto[CancellationResult](ctx, c, "new_session", JSON{"parentSession": nilIfEmpty(parentSession)})
}

// SwitchSession switches to an existing session file.
func (c *Client) SwitchSession(ctx context.Context, sessionPath string) (CancellationResult, error) {
	return requestInto[CancellationResult](ctx, c, "switch_session", JSON{"sessionPath": sessionPath})
}

// Branch branches the session at an entry.
func (c *Client) Branch(ctx context.Context, entryID string) (BranchResult, error) {
	return requestInto[BranchResult](ctx, c, "branch", JSON{"entryId": entryID})
}

// GetBranchMessages returns entries eligible as branch points.
func (c *Client) GetBranchMessages(ctx context.Context) ([]BranchMessage, error) {
	result, err := requestInto[struct {
		Messages []BranchMessage `json:"messages"`
	}](ctx, c, "get_branch_messages", JSON{})
	return result.Messages, err
}

// GetLastAssistantText returns the last assistant text, if any.
func (c *Client) GetLastAssistantText(ctx context.Context) (*string, error) {
	result, err := requestInto[struct {
		Text *string `json:"text"`
	}](ctx, c, "get_last_assistant_text", JSON{})
	return result.Text, err
}

// SetSessionName sets the current session's display name.
func (c *Client) SetSessionName(ctx context.Context, name string) error {
	_, err := c.Request(ctx, "set_session_name", JSON{"name": name})
	return err
}

// GetTodos returns the current todo phases.
func (c *Client) GetTodos(ctx context.Context) ([]TodoPhase, error) {
	state, err := c.GetState(ctx)
	return state.TodoPhases, err
}

// SetTodos replaces all todo phases.
func (c *Client) SetTodos(ctx context.Context, phases []TodoPhase) ([]TodoPhase, error) {
	result, err := requestInto[struct {
		TodoPhases []TodoPhase `json:"todoPhases"`
	}](ctx, c, "set_todos", JSON{"phases": phases})
	return result.TodoPhases, err
}

// ClearTodos clears every todo phase.
func (c *Client) ClearTodos(ctx context.Context) ([]TodoPhase, error) {
	return c.SetTodos(ctx, []TodoPhase{})
}

// GetMessages returns the complete current transcript.
func (c *Client) GetMessages(ctx context.Context) ([]AgentMessage, error) {
	result, err := requestInto[struct {
		Messages []AgentMessage `json:"messages"`
	}](ctx, c, "get_messages", JSON{})
	return result.Messages, err
}

// GetMessagesPage returns a cursor-paginated transcript page.
func (c *Client) GetMessagesPage(ctx context.Context, cursor string, limit int) (MessagesPage, error) {
	payload := JSON{}
	if cursor != "" {
		payload["cursor"] = cursor
	}
	if limit > 0 {
		payload["limit"] = limit
	}
	return requestInto[MessagesPage](ctx, c, "get_messages_page", payload)
}

// SetCustomTools replaces the registered host tools and informs the server.
func (c *Client) SetCustomTools(ctx context.Context, tools []HostTool) ([]string, error) {
	descriptors := make([]JSON, 0, len(tools))
	names := make([]string, 0, len(tools))
	next := make(map[string]HostTool, len(tools))
	for _, tool := range tools {
		if tool.Name == "" || tool.Execute == nil {
			return nil, errors.New("host tools require a name and execute handler")
		}
		next[tool.Name] = tool
		names = append(names, tool.Name)
		descriptors = append(descriptors, JSON{"name": tool.Name, "label": nilIfEmpty(tool.Label), "description": tool.Description, "parameters": tool.Parameters, "hidden": tool.Hidden})
	}
	c.mu.Lock()
	previous := c.hostTools
	c.hostTools = next
	started := c.stream != nil
	c.mu.Unlock()
	if !started {
		return names, nil
	}
	result, err := requestInto[struct {
		ToolNames []string `json:"toolNames"`
	}](ctx, c, "set_host_tools", JSON{"tools": descriptors})
	if err != nil {
		c.mu.Lock()
		c.hostTools = previous
		c.mu.Unlock()
		return nil, err
	}
	return result.ToolNames, nil
}

// SetHostURIs replaces the registered host URI schemes and informs the server.
func (c *Client) SetHostURIs(ctx context.Context, uris []HostURI) ([]string, error) {
	descriptors := make([]JSON, 0, len(uris))
	names := make([]string, 0, len(uris))
	next := make(map[string]HostURI, len(uris))
	for _, uri := range uris {
		normalized, err := normalizeHostURI(uri)
		if err != nil {
			return nil, err
		}
		next[normalized.Scheme] = normalized
		names = append(names, normalized.Scheme)
		descriptors = append(descriptors, JSON{"scheme": normalized.Scheme, "writable": normalized.Write != nil, "immutable": normalized.Immutable, "description": nilIfEmpty(normalized.Description)})
	}
	c.mu.Lock()
	previous := c.hostURIs
	c.hostURIs = next
	started := c.stream != nil
	c.mu.Unlock()
	if !started {
		return names, nil
	}
	result, err := requestInto[struct {
		Schemes []string `json:"schemes"`
	}](ctx, c, "set_host_uri_schemes", JSON{"schemes": descriptors})
	if err != nil {
		c.mu.Lock()
		c.hostURIs = previous
		c.mu.Unlock()
		return nil, err
	}
	return result.Schemes, nil
}

// PromptOptions controls prompt attachments and streaming behavior.
type PromptOptions struct {
	Images            []ImageContent
	StreamingBehavior string
}

// Prompt schedules an agent run.
func (c *Client) Prompt(ctx context.Context, message string, options PromptOptions) error {
	_, err := c.Request(ctx, "prompt", JSON{"message": message, "images": nilIfEmptySlice(options.Images), "streamingBehavior": nilIfEmpty(options.StreamingBehavior)})
	if err == nil {
		c.mu.Lock()
		c.scheduled++
		c.asyncErr = nil
		c.mu.Unlock()
	}
	return err
}

// Steer sends a steering message to an active run.
func (c *Client) Steer(ctx context.Context, message string, images []ImageContent) error {
	_, err := c.Request(ctx, "steer", JSON{"message": message, "images": nilIfEmptySlice(images)})
	return err
}

// FollowUp queues a follow-up message.
func (c *Client) FollowUp(ctx context.Context, message string, images []ImageContent) error {
	_, err := c.Request(ctx, "follow_up", JSON{"message": message, "images": nilIfEmptySlice(images)})
	return err
}

// Abort aborts the active agent run.
func (c *Client) Abort(ctx context.Context) error {
	_, err := c.Request(ctx, "abort", JSON{})
	return err
}

// AbortAndPrompt aborts the active run and schedules a replacement prompt.
func (c *Client) AbortAndPrompt(ctx context.Context, message string, images []ImageContent) error {
	_, err := c.Request(ctx, "abort_and_prompt", JSON{"message": message, "images": nilIfEmptySlice(images)})
	if err == nil {
		c.mu.Lock()
		c.scheduled++
		c.asyncErr = nil
		c.mu.Unlock()
	}
	return err
}

func nilIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func nilIfEmptySlice[T any](value []T) any {
	if value == nil {
		return nil
	}
	return value
}

// MarshalJSONResult validates and copies a dynamic JSON value for host integrations.
func MarshalJSONResult(value any) (json.RawMessage, error) { return json.Marshal(value) }
