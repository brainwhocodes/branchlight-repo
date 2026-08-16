package omprpc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestLegacyStateAndBoundedEventOverflow(t *testing.T) {
	var state SessionState
	if err := json.Unmarshal([]byte(`{"sessionId":"s","systemPrompt":"legacy"}`), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.SystemPrompt) != 1 || state.SystemPrompt[0] != "legacy" {
		t.Fatalf("legacy systemPrompt was not normalized: %#v", state.SystemPrompt)
	}
	client, err := New(Config{MaxEventHistory: 1})
	if err != nil {
		t.Fatal(err)
	}
	client.appendEvent(&AgentStartEvent{agentEventBase: agentEventBase{eventBase{Type: "agent_start"}}})
	client.appendEvent(&TurnStartEvent{agentEventBase: agentEventBase{eventBase{Type: "turn_start"}}})
	if _, err := client.waitForAgentEnd(context.Background(), 0); err == nil {
		t.Fatal("collector did not report event history overflow")
	}
}

func TestLifecycleConcurrencyGuardAndListenerIsolation(t *testing.T) {
	client, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	listenerErrors := make(chan ListenerError, 1)
	client.OnListenerError(func(event ListenerError) { listenerErrors <- event })
	client.OnNotification(func(Notification) { panic("listener failure") })
	client.dispatch(UnknownNotification{eventBase: eventBase{Type: "unknown"}, Payload: JSON{}})
	select {
	case <-listenerErrors:
	case <-time.After(time.Second):
		t.Fatal("listener panic was not isolated and reported")
	}
	if err := client.acquireLifecycle("collect_events"); err != nil {
		t.Fatal(err)
	}
	err = client.WaitForIdle(context.Background())
	var concurrencyError *ConcurrencyError
	if !errors.As(err, &concurrencyError) {
		t.Fatalf("expected ConcurrencyError, got %v", err)
	}
	client.releaseLifecycle("collect_events")
}

func TestHeadlessUIDefaultPredicates(t *testing.T) {
	if !(ExtensionUIRequest{Method: "open_url"}).IsPassive() {
		t.Fatal("open_url must be passive")
	}
	if !(ExtensionUIRequest{Method: "editor"}).AcceptsText() {
		t.Fatal("editor must accept text")
	}
	if (ExtensionUIRequest{Method: "cancel"}).RequiresResponse() {
		t.Fatal("cancel must not require a response")
	}
}
