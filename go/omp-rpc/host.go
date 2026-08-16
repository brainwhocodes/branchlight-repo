package omprpc

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// HostToolResult is a custom host tool result or update.
type HostToolResult struct {
	Content []JSON `json:"content"`
	Details any    `json:"details,omitempty"`
}

// TextToolResult creates a text-only host tool result.
func TextToolResult(text string) HostToolResult {
	return HostToolResult{Content: []JSON{{"type": "text", "text": text}}}
}

// HostToolContext provides call identity, cancellation, and partial updates.
type HostToolContext struct {
	ToolCallID string
	ctx        context.Context
	update     func(HostToolResult) error
}

// Context returns the request context, cancelled by host_tool_cancel or Client.Close.
func (c *HostToolContext) Context() context.Context { return c.ctx }

// Cancelled reports whether the server cancelled the call.
func (c *HostToolContext) Cancelled() bool { return c.ctx.Err() != nil }

// SendUpdate sends a partial result unless the call has been cancelled.
func (c *HostToolContext) SendUpdate(result HostToolResult) error {
	if err := c.ctx.Err(); err != nil {
		return err
	}
	return c.update(result)
}

// HostTool defines a tool executed by the embedding Go process.
type HostTool struct {
	Name        string
	Label       string
	Description string
	Parameters  JSON
	Hidden      bool
	Execute     func(context.Context, JSON, *HostToolContext) (HostToolResult, error)
}

// HostURIReadResult is a structured host URI read response.
type HostURIReadResult struct {
	Content     string   `json:"content"`
	ContentType string   `json:"contentType,omitempty"`
	Notes       []string `json:"notes,omitempty"`
	Immutable   *bool    `json:"immutable,omitempty"`
}

// HostURIContext provides URI request identity and cancellation.
type HostURIContext struct {
	URL       string
	Operation string
	ctx       context.Context
}

// Context returns the request context, cancelled by host_uri_cancel or Client.Close.
func (c *HostURIContext) Context() context.Context { return c.ctx }

// Cancelled reports whether the URI request was cancelled.
func (c *HostURIContext) Cancelled() bool { return c.ctx.Err() != nil }

// HostURI defines a custom URI scheme served by the embedding Go process.
type HostURI struct {
	Scheme      string
	Description string
	Immutable   bool
	Read        func(context.Context, string, *HostURIContext) (HostURIReadResult, error)
	Write       func(context.Context, string, string, *HostURIContext) error
}

// Writable reports whether the URI scheme accepts full-content writes.
func (u HostURI) Writable() bool { return u.Write != nil }

func normalizeHostURI(uri HostURI) (HostURI, error) {
	uri.Scheme = strings.ToLower(strings.TrimSpace(uri.Scheme))
	if uri.Scheme == "" {
		return uri, fmt.Errorf("host URI scheme must not be empty")
	}
	parsed, err := url.Parse(uri.Scheme + "://value")
	if err != nil || parsed.Scheme != uri.Scheme {
		return uri, fmt.Errorf("invalid host URI scheme %q", uri.Scheme)
	}
	if uri.Read == nil {
		return uri, fmt.Errorf("host URI %q requires a read handler", uri.Scheme)
	}
	return uri, nil
}
