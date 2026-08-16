package omprpc

func onTyped[T AgentEvent](client *Client, eventType string, listener func(T)) func() {
	return client.OnEventType(eventType, func(event AgentEvent) {
		if typed, ok := event.(T); ok {
			listener(typed)
		}
	})
}

// OnAgentStart registers a typed agent_start listener.
func (c *Client) OnAgentStart(listener func(*AgentStartEvent)) func() {
	return onTyped(c, "agent_start", listener)
}

// OnAgentEnd registers a typed agent_end listener.
func (c *Client) OnAgentEnd(listener func(*AgentEndEvent)) func() {
	return onTyped(c, "agent_end", listener)
}

// OnTurnStart registers a typed turn_start listener.
func (c *Client) OnTurnStart(listener func(*TurnStartEvent)) func() {
	return onTyped(c, "turn_start", listener)
}

// OnTurnEnd registers a typed turn_end listener.
func (c *Client) OnTurnEnd(listener func(*TurnEndEvent)) func() {
	return onTyped(c, "turn_end", listener)
}

// OnMessageStart registers a typed message_start listener.
func (c *Client) OnMessageStart(listener func(*MessageStartEvent)) func() {
	return onTyped(c, "message_start", listener)
}

// OnMessageUpdate registers a typed message_update listener.
func (c *Client) OnMessageUpdate(listener func(*MessageUpdateEvent)) func() {
	return onTyped(c, "message_update", listener)
}

// OnMessageEnd registers a typed message_end listener.
func (c *Client) OnMessageEnd(listener func(*MessageEndEvent)) func() {
	return onTyped(c, "message_end", listener)
}

// OnToolExecutionStart registers a typed tool_execution_start listener.
func (c *Client) OnToolExecutionStart(listener func(*ToolExecutionStartEvent)) func() {
	return onTyped(c, "tool_execution_start", listener)
}

// OnToolExecutionUpdate registers a typed tool_execution_update listener.
func (c *Client) OnToolExecutionUpdate(listener func(*ToolExecutionUpdateEvent)) func() {
	return onTyped(c, "tool_execution_update", listener)
}

// OnToolExecutionEnd registers a typed tool_execution_end listener.
func (c *Client) OnToolExecutionEnd(listener func(*ToolExecutionEndEvent)) func() {
	return onTyped(c, "tool_execution_end", listener)
}

// OnAutoCompactionStart registers a typed auto_compaction_start listener.
func (c *Client) OnAutoCompactionStart(listener func(*AutoCompactionStartEvent)) func() {
	return onTyped(c, "auto_compaction_start", listener)
}

// OnAutoCompactionEnd registers a typed auto_compaction_end listener.
func (c *Client) OnAutoCompactionEnd(listener func(*AutoCompactionEndEvent)) func() {
	return onTyped(c, "auto_compaction_end", listener)
}

// OnAutoRetryStart registers a typed auto_retry_start listener.
func (c *Client) OnAutoRetryStart(listener func(*AutoRetryStartEvent)) func() {
	return onTyped(c, "auto_retry_start", listener)
}

// OnAutoRetryEnd registers a typed auto_retry_end listener.
func (c *Client) OnAutoRetryEnd(listener func(*AutoRetryEndEvent)) func() {
	return onTyped(c, "auto_retry_end", listener)
}

// OnRetryFallbackApplied registers a typed retry_fallback_applied listener.
func (c *Client) OnRetryFallbackApplied(listener func(*RetryFallbackAppliedEvent)) func() {
	return onTyped(c, "retry_fallback_applied", listener)
}

// OnRetryFallbackSucceeded registers a typed retry_fallback_succeeded listener.
func (c *Client) OnRetryFallbackSucceeded(listener func(*RetryFallbackSucceededEvent)) func() {
	return onTyped(c, "retry_fallback_succeeded", listener)
}

// OnTTSRTriggered registers a typed ttsr_triggered listener.
func (c *Client) OnTTSRTriggered(listener func(*TTSRTriggeredEvent)) func() {
	return onTyped(c, "ttsr_triggered", listener)
}

// OnTodoReminder registers a typed todo_reminder listener.
func (c *Client) OnTodoReminder(listener func(*TodoReminderEvent)) func() {
	return onTyped(c, "todo_reminder", listener)
}

// OnTodoAutoClear registers a typed todo_auto_clear listener.
func (c *Client) OnTodoAutoClear(listener func(*TodoAutoClearEvent)) func() {
	return onTyped(c, "todo_auto_clear", listener)
}
