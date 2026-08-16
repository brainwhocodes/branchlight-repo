package omprpc

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

func (c *Client) registerCallback(id string) (context.Context, context.CancelFunc, bool) {
	ctx, cancel := context.WithCancel(context.Background())
	c.mu.Lock()
	select {
	case <-c.closed:
		c.mu.Unlock()
		cancel()
		return ctx, cancel, false
	default:
	}
	if previous := c.callbackCancels[id]; previous != nil {
		previous()
	}
	c.callbackCancels[id] = cancel
	c.callbackWG.Add(1)
	c.mu.Unlock()
	return ctx, cancel, true
}
func (c *Client) finishCallback(id string, cancel context.CancelFunc) {
	cancel()
	c.mu.Lock()
	delete(c.callbackCancels, id)
	c.mu.Unlock()
}
func (c *Client) cancelCallback(id string) {
	c.mu.Lock()
	cancel := c.callbackCancels[id]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *Client) handleHostToolCall(payload JSON) {
	id, idOK := payload["id"].(string)
	name, nameOK := payload["toolName"].(string)
	callID, callOK := payload["toolCallId"].(string)
	arguments, argsOK := payload["arguments"].(map[string]any)
	if !idOK || !nameOK || !callOK {
		return
	}
	if !argsOK {
		_ = c.sendPush("host_tool_result", JSON{"id": id, "result": TextToolResult("Host tool arguments must be an object"), "isError": true})
		return
	}
	c.mu.Lock()
	tool, found := c.hostTools[name]
	if found {
		c.hostToolDispatchNames[callID] = name
	}
	c.mu.Unlock()
	if !found {
		_ = c.sendPush("host_tool_result", JSON{"id": id, "result": TextToolResult(fmt.Sprintf("Host tool %q is not registered", name)), "isError": true})
		return
	}
	ctx, cancel, accepted := c.registerCallback(id)
	if !accepted {
		return
	}
	go func() {
		defer c.callbackWG.Done()
		defer c.finishCallback(id, cancel)
		toolContext := &HostToolContext{ToolCallID: callID, ctx: ctx, update: func(result HostToolResult) error {
			return c.sendPush("host_tool_update", JSON{"id": id, "partialResult": result})
		}}
		result, err := tool.Execute(ctx, JSON(arguments), toolContext)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			_ = c.sendPush("host_tool_result", JSON{"id": id, "result": TextToolResult(err.Error()), "isError": true})
			return
		}
		_ = c.sendPush("host_tool_result", JSON{"id": id, "result": result})
	}()
}

func (c *Client) handleHostURIRequest(payload JSON) {
	id, idOK := payload["id"].(string)
	operation, operationOK := payload["operation"].(string)
	rawURL, urlOK := payload["url"].(string)
	if !idOK || !operationOK || !urlOK {
		return
	}
	if operation != "read" && operation != "write" {
		c.sendHostURIError(id, "Unsupported host URI operation: "+operation)
		return
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" {
		c.sendHostURIError(id, "Could not parse host URI: "+rawURL)
		return
	}
	c.mu.Lock()
	handler, found := c.hostURIs[strings.ToLower(parsed.Scheme)]
	c.mu.Unlock()
	if !found {
		c.sendHostURIError(id, fmt.Sprintf("Host URI scheme %q is not registered", parsed.Scheme+"://"))
		return
	}
	if operation == "write" && handler.Write == nil {
		c.sendHostURIError(id, fmt.Sprintf("Host URI scheme %q has no write handler", parsed.Scheme+"://"))
		return
	}
	ctx, cancel, accepted := c.registerCallback(id)
	if !accepted {
		return
	}
	go func() {
		defer c.callbackWG.Done()
		defer c.finishCallback(id, cancel)
		uriContext := &HostURIContext{URL: rawURL, Operation: operation, ctx: ctx}
		if operation == "read" {
			result, readErr := handler.Read(ctx, rawURL, uriContext)
			if ctx.Err() != nil {
				return
			}
			if readErr != nil {
				c.sendHostURIError(id, readErr.Error())
				return
			}
			if result.ContentType != "" && result.ContentType != "text/markdown" && result.ContentType != "application/json" && result.ContentType != "text/plain" {
				c.sendHostURIError(id, "Unsupported content type: "+result.ContentType)
				return
			}
			body := JSON{"id": id, "content": result.Content}
			if result.ContentType != "" {
				body["contentType"] = result.ContentType
			}
			if result.Notes != nil {
				body["notes"] = result.Notes
			}
			if result.Immutable != nil {
				body["immutable"] = *result.Immutable
			}
			_ = c.sendPush("host_uri_result", body)
			return
		}
		content, _ := payload["content"].(string)
		writeErr := handler.Write(ctx, rawURL, content, uriContext)
		if ctx.Err() != nil {
			return
		}
		if writeErr != nil {
			c.sendHostURIError(id, writeErr.Error())
			return
		}
		_ = c.sendPush("host_uri_result", JSON{"id": id})
	}()
}

func (c *Client) sendHostURIError(id, message string) {
	_ = c.sendPush("host_uri_result", JSON{"id": id, "error": message, "isError": true})
}
