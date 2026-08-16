package omprpc

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// UnmarshalJSON accepts both the current systemPrompt array and the legacy scalar string.
func (s *SessionState) UnmarshalJSON(data []byte) error {
	type alias SessionState
	var wire struct {
		*alias
		SystemPrompt json.RawMessage `json:"systemPrompt"`
	}
	wire.alias = (*alias)(s)
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	s.SystemPrompt = nil
	if len(wire.SystemPrompt) == 0 || bytes.Equal(wire.SystemPrompt, []byte("null")) {
		return nil
	}
	if wire.SystemPrompt[0] == '"' {
		var prompt string
		if err := json.Unmarshal(wire.SystemPrompt, &prompt); err != nil {
			return err
		}
		s.SystemPrompt = []string{prompt}
		return nil
	}
	if err := json.Unmarshal(wire.SystemPrompt, &s.SystemPrompt); err != nil {
		return fmt.Errorf("systemPrompt must be a string or string array: %w", err)
	}
	return nil
}
