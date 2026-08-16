package omprpc

import (
	"context"
	"errors"
	"fmt"
)

func (c *Client) acquireLifecycle(name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lifecycle != "" {
		return &ConcurrencyError{Active: c.lifecycle, Requested: name}
	}
	c.lifecycle = name
	return nil
}
func (c *Client) releaseLifecycle(name string) {
	c.mu.Lock()
	if c.lifecycle == name {
		c.lifecycle = ""
	}
	c.mu.Unlock()
}
func (c *Client) currentEventIndex() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.eventOffset + uint64(len(c.events))
}

func (c *Client) waitForAgentEnd(ctx context.Context, start uint64) ([]AgentEvent, error) {
	for {
		c.mu.Lock()
		if len(c.events) != 0 && start < c.events[0].index {
			c.mu.Unlock()
			return nil, errors.New("event history was truncated while waiting for agent_end")
		}
		collected := make([]AgentEvent, 0)
		terminal := false
		for _, item := range c.events {
			if item.index < start {
				continue
			}
			collected = append(collected, item.event)
			if end, ok := item.event.(*AgentEndEvent); ok && (end.IsTerminal == nil || *end.IsTerminal) {
				terminal = true
				break
			}
		}
		asyncErr := c.asyncErr
		c.mu.Unlock()
		if terminal {
			return collected, nil
		}
		if asyncErr != nil {
			return nil, asyncErr
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for agent_end: %w", ctx.Err())
		case <-c.closed:
			return nil, errors.New("omp RPC client closed")
		case <-c.eventSignal:
		}
	}
}

// PromptAndWait schedules a prompt and collects events through its terminal agent_end.
func (c *Client) PromptAndWait(ctx context.Context, message string, options PromptOptions) (PromptTurn, error) {
	const operation = "prompt_and_wait"
	if err := c.acquireLifecycle(operation); err != nil {
		return PromptTurn{}, err
	}
	defer c.releaseLifecycle(operation)
	start := c.currentEventIndex()
	if err := c.Prompt(ctx, message, options); err != nil {
		return PromptTurn{}, err
	}
	events, err := c.waitForAgentEnd(ctx, start)
	if err != nil {
		return PromptTurn{}, err
	}
	turn := PromptTurn{Events: events}
	for index := len(events) - 1; index >= 0; index-- {
		if end, ok := events[index].(*AgentEndEvent); ok {
			messages, completeErr := completeAgentEndMessages(events[:index], end)
			if completeErr != nil {
				return PromptTurn{}, completeErr
			}
			turn.Messages = messages
			break
		}
	}
	for index := len(turn.Messages) - 1; index >= 0; index-- {
		if turn.Messages[index].Role == "assistant" {
			turn.AssistantMessage = &turn.Messages[index]
			if text, ok := MessageText(turn.Messages[index], false); ok {
				turn.AssistantText = text
				turn.HasAssistantText = true
			}
			break
		}
	}
	if turn.AssistantMessage == nil {
		for index := len(events) - 1; index >= 0; index-- {
			var message *AgentMessage
			switch event := events[index].(type) {
			case *MessageEndEvent:
				message = &event.Message
			case *TurnEndEvent:
				message = &event.Message
			}
			if message != nil && message.Role == "assistant" {
				turn.AssistantMessage = message
				if text, ok := MessageText(*message, false); ok {
					turn.AssistantText = text
					turn.HasAssistantText = true
				}
				break
			}
		}
	}
	return turn, nil
}

func completeAgentEndMessages(events []AgentEvent, terminal *AgentEndEvent) ([]AgentMessage, error) {
	if terminal.MessageCount == nil || *terminal.MessageCount <= len(terminal.Messages) {
		return append([]AgentMessage(nil), terminal.Messages...), nil
	}
	runStart := 0
	for index := len(events) - 1; index >= 0; index-- {
		if _, ok := events[index].(*AgentStartEvent); ok {
			runStart = index + 1
			break
		}
	}
	streamed := make([]AgentMessage, 0)
	for _, event := range events[runStart:] {
		if messageEnd, ok := event.(*MessageEndEvent); ok {
			streamed = append(streamed, messageEnd.Message)
		}
	}
	prefixCount := *terminal.MessageCount - len(terminal.Messages)
	if prefixCount > len(streamed) {
		return nil, fmt.Errorf("compacted agent_end references %d streamed messages, but only %d were retained", prefixCount, len(streamed))
	}
	result := append([]AgentMessage(nil), streamed[:prefixCount]...)
	return append(result, terminal.Messages...), nil
}

// WaitForIdle waits for all scheduled prompt runs to complete.
func (c *Client) WaitForIdle(ctx context.Context) error {
	const operation = "wait_for_idle"
	if err := c.acquireLifecycle(operation); err != nil {
		return err
	}
	defer c.releaseLifecycle(operation)
	for {
		c.mu.Lock()
		idle := c.scheduled == c.completed
		asyncErr := c.asyncErr
		start := c.eventOffset + uint64(len(c.events))
		c.mu.Unlock()
		if idle {
			return asyncErr
		}
		if _, err := c.waitForAgentEnd(ctx, start); err != nil {
			return err
		}
	}
}

// CollectEvents collects the next run's lifecycle events through terminal agent_end.
func (c *Client) CollectEvents(ctx context.Context) ([]AgentEvent, error) {
	const operation = "collect_events"
	if err := c.acquireLifecycle(operation); err != nil {
		return nil, err
	}
	defer c.releaseLifecycle(operation)
	return c.waitForAgentEnd(ctx, c.currentEventIndex())
}

// AssistantText extracts assistant text content. When includeThinking is true, thinking content is included.
func AssistantText(message AgentMessage, includeThinking bool) string {
	if message.Role != "assistant" {
		return ""
	}
	text, _ := MessageText(message, includeThinking)
	return text
}

// NextUIRequest waits for the next extension UI request.
func (c *Client) NextUIRequest(ctx context.Context) (ExtensionUIRequest, error) {
	select {
	case request := <-c.uiRequests:
		return request, nil
	case <-ctx.Done():
		return ExtensionUIRequest{}, fmt.Errorf("wait for extension UI request: %w", ctx.Err())
	case <-c.closed:
		return ExtensionUIRequest{}, errors.New("omp RPC client closed")
	}
}

// SendUIValue answers a select, input, or editor request.
func (c *Client) SendUIValue(requestID, value string) error {
	return c.sendPush("extension_ui_response", JSON{"id": requestID, "value": value})
}

// SendUIConfirmation answers a confirmation request.
func (c *Client) SendUIConfirmation(requestID string, confirmed bool) error {
	return c.sendPush("extension_ui_response", JSON{"id": requestID, "confirmed": confirmed})
}

// CancelUIRequest cancels an interactive UI request.
func (c *Client) CancelUIRequest(requestID string, timedOut bool) error {
	payload := JSON{"id": requestID, "cancelled": true}
	if timedOut {
		payload["timedOut"] = true
	}
	return c.sendPush("extension_ui_response", payload)
}

// HeadlessUIOptions controls automatic responses for non-interactive hosts.
type HeadlessUIOptions struct {
	Confirm     bool
	SelectValue *string
	InputValue  *string
	EditorValue *string
	OnRequest   func(ExtensionUIRequest)
}

// InstallHeadlessUI installs safe non-interactive defaults and returns an unsubscribe function.
func (c *Client) InstallHeadlessUI(options HeadlessUIOptions) func() {
	return c.OnNotification(func(notification Notification) {
		request, ok := notification.(*ExtensionUIRequest)
		if !ok {
			return
		}
		if options.OnRequest != nil {
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						c.recordListenerError(ListenerError{Kind: "headless_ui_request", SourceType: request.EventType(), Panic: recovered})
					}
				}()
				options.OnRequest(*request)
			}()
		}
		if request.Method == "cancel" || request.IsPassive() {
			return
		}
		switch request.Method {
		case "confirm":
			_ = c.SendUIConfirmation(request.ID, options.Confirm)
		case "select":
			if options.SelectValue != nil {
				_ = c.SendUIValue(request.ID, *options.SelectValue)
			} else {
				_ = c.CancelUIRequest(request.ID, false)
			}
		case "input":
			if options.InputValue != nil {
				_ = c.SendUIValue(request.ID, *options.InputValue)
			} else {
				_ = c.CancelUIRequest(request.ID, false)
			}
		case "editor":
			if options.EditorValue != nil {
				_ = c.SendUIValue(request.ID, *options.EditorValue)
			} else {
				_ = c.CancelUIRequest(request.ID, false)
			}
		}
	})
}
