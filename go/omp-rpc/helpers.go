package omprpc

import (
	"encoding/base64"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// ImageFromPath reads and base64-encodes an image attachment. An empty MIME type is inferred from the extension.
func ImageFromPath(path, mimeType string) (ImageContent, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ImageContent{}, err
	}
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(path))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return ImageContent{Type: "image", MimeType: mimeType, Data: base64.StdEncoding.EncodeToString(data)}, nil
}

// MessageText extracts visible text from a textual agent message and optionally includes thinking text.
func MessageText(message AgentMessage, includeThinking bool) (string, bool) {
	switch message.Role {
	case "user", "developer", "assistant", "toolResult", "custom", "hookMessage":
	default:
		return "", false
	}
	if message.Content.Text != nil {
		return *message.Content.Text, true
	}
	var builder strings.Builder
	for _, block := range message.Content.Blocks {
		if block.Type == "text" {
			builder.WriteString(block.Text)
		} else if includeThinking && block.Type == "thinking" {
			builder.WriteString(block.Thinking)
		}
	}
	if builder.Len() == 0 {
		return "", false
	}
	return builder.String(), true
}
