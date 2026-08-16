package omprpc

import (
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	protocolVersion     = uint32(1)
	maxMessageBytes     = 64 * 1024 * 1024
	defaultHistoryLimit = 128
)

// Config controls omp process launch and SDK resource bounds.
type Config struct {
	// Command, when non-empty, replaces Executable and every generated CLI argument.
	Command []string
	// Executable is the omp executable used when Command is empty. It defaults to "omp".
	Executable string
	Provider   string
	Model      string
	SessionDir string
	Cwd        string
	Env        map[string]string
	// User and Group accept either a decimal id or an operating-system account name.
	User  string
	Group string
	// ExtraGroups accepts decimal ids or operating-system group names.
	ExtraGroups        []string
	Thinking           string
	AppendSystemPrompt string
	ProviderSessionID  string
	// Tools distinguishes nil (do not pass a tools option) from an empty non-nil slice (--no-tools).
	Tools     []string
	NoSession bool
	NoSkills  bool
	NoRules   bool
	// NoTitle overrides the RPC default. Nil follows RPCDefaults, which defaults to true.
	NoTitle *bool
	// RPCDefaults defaults to true; set DisableRPCDefaults to suppress RPC-specific CLI defaults.
	DisableRPCDefaults bool
	ExtraArgs          []string
	StartupTimeout     time.Duration
	RequestTimeout     time.Duration
	MaxEventHistory    int
	MaxStderrChunks    int
	// UnboundedEventHistory and UnboundedStderrHistory represent Python's None history limits.
	UnboundedEventHistory  bool
	UnboundedStderrHistory bool
	ProtocolErrorHistory   int
	ListenerErrorHistory   int
	HostTools              []HostTool
	HostURIs               []HostURI
}

func (c Config) validate() error {
	for name, value := range map[string]int{"MaxEventHistory": c.MaxEventHistory, "MaxStderrChunks": c.MaxStderrChunks, "ProtocolErrorHistory": c.ProtocolErrorHistory, "ListenerErrorHistory": c.ListenerErrorHistory} {
		if value < 0 {
			return fmt.Errorf("%s must be positive when set", name)
		}
	}
	if c.UnboundedEventHistory && c.MaxEventHistory != 0 {
		return fmt.Errorf("UnboundedEventHistory conflicts with MaxEventHistory")
	}
	if c.UnboundedStderrHistory && c.MaxStderrChunks != 0 {
		return fmt.Errorf("UnboundedStderrHistory conflicts with MaxStderrChunks")
	}
	if c.StartupTimeout < 0 || c.RequestTimeout < 0 {
		return fmt.Errorf("timeouts must not be negative")
	}
	return nil
}

func (c Config) normalized() Config {
	if c.Executable == "" {
		c.Executable = "omp"
	}
	if c.StartupTimeout <= 0 {
		c.StartupTimeout = 30 * time.Second
	}
	if c.RequestTimeout <= 0 {
		c.RequestTimeout = 30 * time.Second
	}
	if c.MaxEventHistory == 0 {
		c.MaxEventHistory = 10_000
	}
	if c.UnboundedEventHistory {
		c.MaxEventHistory = -1
	}
	if c.UnboundedStderrHistory {
		c.MaxStderrChunks = -1
	}
	if c.MaxStderrChunks == 0 {
		c.MaxStderrChunks = 512
	}
	if c.ProtocolErrorHistory == 0 {
		c.ProtocolErrorHistory = defaultHistoryLimit
	}
	if c.ListenerErrorHistory == 0 {
		c.ListenerErrorHistory = defaultHistoryLimit
	}
	return c
}

func (c Config) command() []string {
	if len(c.Command) != 0 {
		return append([]string(nil), c.Command...)
	}
	args := []string{c.Executable, "--mode", "rpc"}
	appendValue := func(flag, value string) {
		if value != "" {
			args = append(args, flag, value)
		}
	}
	appendValue("--provider", c.Provider)
	appendValue("--model", c.Model)
	appendValue("--session-dir", c.SessionDir)
	appendValue("--thinking", c.Thinking)
	appendValue("--append-system-prompt", c.AppendSystemPrompt)
	appendValue("--provider-session-id", c.ProviderSessionID)
	if c.Tools != nil {
		if len(c.Tools) == 0 {
			args = append(args, "--no-tools")
		} else {
			args = append(args, "--tools", strings.Join(c.Tools, ","))
		}
	}
	if c.NoSession {
		args = append(args, "--no-session")
	}
	if c.NoSkills {
		args = append(args, "--no-skills")
	}
	if c.NoRules {
		args = append(args, "--no-rules")
	}
	emitNoTitle := !c.DisableRPCDefaults
	if c.NoTitle != nil {
		emitNoTitle = *c.NoTitle
	}
	if emitNoTitle {
		args = append(args, "--no-title")
	}
	return append(args, c.ExtraArgs...)
}

func mergedEnv(overrides map[string]string, grpcEnv map[string]string) []string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	for key, value := range overrides {
		values[key] = value
	}
	for key, value := range grpcEnv {
		values[key] = value
	}
	result := make([]string, 0, len(values))
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}
