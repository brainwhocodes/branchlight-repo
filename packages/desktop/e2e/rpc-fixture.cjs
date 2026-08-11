const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const performanceFixture = process.env.BRANCHLIGHT_PERF_FIXTURE === "1";
const performanceMessages = performanceFixture
  ? Array.from({ length: 10_000 }, (_, index) => ({
      id: `performance-${index}`,
      role: "assistant",
      content: [{ type: "text", text: `Performance timeline entry ${index}` }],
    }))
  : undefined;
if (performanceMessages) {
  const reasoningChunk = "x".repeat(512 * 1024);
  for (const message of performanceMessages.slice(-10)) message.content.unshift({ type: "thinking", thinking: reasoningChunk });
}

const availableCommands = [
  { name: "status", aliases: ["usage"], description: "Show current session status", source: "builtin" },
  { name: "compact", description: "Compact the current context", input: { hint: "custom instructions" }, source: "builtin" },
  { name: "model", description: "Choose the active model", source: "builtin" },
  { name: "thinking", description: "Choose the reasoning level", source: "builtin" },
  { name: "fast", description: "Toggle fast mode", source: "builtin" },
  { name: "handoff", description: "Create a handoff prompt", input: { hint: "instructions" }, source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Resume another session", source: "builtin" },
  { name: "branch", description: "Branch from an earlier message", source: "builtin" },
  { name: "export", description: "Export the transcript", source: "builtin" },
  { name: "copy", description: "Copy the last assistant response", source: "builtin" },
  { name: "clear", description: "Clear the visible transcript", source: "builtin" },
  { name: "reload", description: "Reload extensions and skills", source: "builtin" },
  { name: "theme", description: "Change the interface theme", source: "builtin" },
  { name: "login", description: "Authenticate a provider", source: "builtin" },
  { name: "logout", description: "Sign out of a provider", source: "builtin" },
  { name: "fixture-review", description: "Review the fixture workspace", source: "skill" },
  { name: "fixture-release", description: "Prepare fixture release notes", source: "custom" },
];
const modelOptions = [
  { provider: "fixture", id: "fixture-model", name: "Fixture Model", reasoning: true, contextWindow: 4096 },
  { provider: "fixture", id: "fast-model", name: "Fast Fixture", reasoning: true, contextWindow: 8192 },
  { provider: "alternate", id: "compact-model", name: "Compact Fixture", reasoning: false, contextWindow: 2048 },
];
let agentSettings = [
  {
    path: "personality",
    tab: "model",
    group: "Prompt behavior",
    label: "Personality",
    description: "Communication style rendered into the system prompt.",
    control: "select",
    value: "default",
    options: [
      { value: "default", label: "Default" },
      { value: "friendly", label: "Friendly" },
      { value: "pragmatic", label: "Pragmatic" },
      { value: "none", label: "None" },
    ],
    apply: "immediate",
  },
  {
    path: "images.autoResize",
    tab: "appearance",
    group: "Images",
    label: "Resize large images",
    description: "Resize oversized image inputs before sending them to the model.",
    control: "toggle",
    value: true,
    apply: "immediate",
  },
  {
    path: "tools.approvalMode",
    tab: "interaction",
    group: "Approvals",
    label: "Tool approval mode",
    description: "Choose which tool operations require confirmation.",
    control: "select",
    value: "yolo",
    options: [
      { value: "always-ask", label: "Always ask" },
      { value: "write", label: "Ask for writes" },
      { value: "yolo", label: "Auto-approve" },
    ],
    apply: "immediate",
  },
  {
    path: "compaction.strategy",
    tab: "context",
    group: "Compaction",
    label: "Compaction strategy",
    description: "How OMP reduces long context windows.",
    control: "select",
    value: "snapcompact",
    options: [
      { value: "context-full", label: "Context full" },
      { value: "handoff", label: "Handoff" },
      { value: "shake", label: "Shake" },
      { value: "snapcompact", label: "Snapcompact" },
      { value: "off", label: "Off" },
    ],
    apply: "immediate",
  },
  {
    path: "generate_image.enabled",
    tab: "tools",
    group: "Native media",
    label: "Generate image",
    description: "Expose the native image generation tool to the agent.",
    control: "toggle",
    value: true,
    apply: "next-session",
  },
  {
    path: "inspect_image.mode",
    tab: "tools",
    group: "Native media",
    label: "Inspect image",
    description: "Control when the delegated image inspection tool is exposed.",
    control: "select",
    value: "auto",
    options: [
      { value: "auto", label: "Auto" },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ],
    apply: "immediate",
  },
  {
    path: "task.maxConcurrency",
    tab: "tasks",
    group: "Delegation",
    label: "Maximum collaborators",
    description: "Maximum number of subagents that can run concurrently.",
    control: "select",
    value: 32,
    options: [
      { value: 4, label: "4" },
      { value: 8, label: "8" },
      { value: 16, label: "16" },
      { value: 32, label: "32" },
    ],
    apply: "immediate",
  },
];
const historyMessages = performanceMessages ?? [{ id: "fixture-welcome", role: "assistant", content: [{ type: "text", text: "Fixture ready. Choose a Work or Code action." }] }];
const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const resumeIndex = args.indexOf("--resume");
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : path.join(cwd, ".branchlight-fixture.jsonl");
const sessionId = "fixture-session-0001";
const authStateFile = process.env.BRANCHLIGHT_AUTH_FILE;
let authenticated = Boolean(authStateFile && fs.existsSync(authStateFile));
let pendingAuth;
let pendingAgentPrompt;
let model = modelOptions[0];
let thinkingLevel = "medium";
let fastModeEnabled = false;
let steeringMode = "all";
let followUpMode = "all";
let interruptMode = "immediate";
let autoCompactionEnabled = true;
let autoRetryEnabled = true;

fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "fixture\n", "utf8");

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

send({ type: "ready", maxFrameBytes: 1024 * 1024, maxReassembledFrameBytes: 64 * 1024 * 1024 });
setTimeout(() => send({ type: "available_commands_update", commands: availableCommands }), 10);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    send({ type: "rpc_frame_error", error: "fixture received malformed JSON" });
    return;
  }
  const response = (data, success = true, responseId = command.id, responseCommand = command.type) => send({
    type: "response",
    id: responseId,
    command: responseCommand,
    success,
    ...(success ? { data } : { error: "fixture command failed" }),
  });
  const emitPromptResult = promptCommand => {
    const generatedImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const answerId = `fixture-answer-${Date.now()}`;
    response({ agentInvoked: true }, true, promptCommand.id, "prompt");
    send({ type: "agent_start" });
    send({ type: "message_start", message: { id: `user-${Date.now()}`, role: "user", content: promptCommand.message } });
    send({ type: "message_start", message: { id: answerId, role: "assistant", content: [] } });
    send({ type: "message_update", message: { id: answerId, role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the fixture boundary." }] } });
    send({ type: "tool_execution_start", toolCallId: "fixture-write", toolName: "write", args: { path: "result.txt" } });
    send({ type: "tool_execution_end", toolCallId: "fixture-write", result: "BRANCHLIGHT_READY", isError: false });
    send({ type: "message_update", message: { id: answerId, role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the fixture boundary.\nValidating the projected result." }] } });
    send({ type: "tool_execution_start", toolCallId: "fixture-image", toolName: "generate_image", args: { subject: "fixture image" } });
    send({ type: "tool_execution_update", toolCallId: "fixture-image", partialResult: { content: [{ type: "text", text: "Generating image…" }], details: { images: [] } } });
    setTimeout(() => {
      send({
        type: "tool_execution_end",
        toolCallId: "fixture-image",
        result: { content: [{ type: "text", text: "Generated image." }], details: { images: [{ data: generatedImage, mimeType: "image/png" }] } },
        isError: false,
      });
      send({ type: "message_end", message: { id: answerId, role: "assistant", content: [{ type: "thinking", thinking: "Inspecting the fixture boundary.\nValidating the projected result." }, { type: "text", text: "Fixture completed the requested work." }] } });
      send({ type: "agent_end", isTerminal: false, messages: [] });
      send({ type: "agent_end", isTerminal: true, messages: [] });
    }, 400);
  };

  if (command.type === "negotiate_protocol") return response({ protocolVersion: 2 });
  if (command.type === "get_state") return response({
    sessionId,
    sessionFile,
    model,
    thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    steeringMode,
    followUpMode,
    interruptMode,
    autoCompactionEnabled,
    autoRetryEnabled,
    fastModeEnabled,
    fastModeActive: fastModeEnabled,
    contextUsage: { tokens: 128, contextWindow: model.contextWindow },
    tokensPerSecond: 22,
    messageCount: historyMessages.length,
    queuedMessageCount: 0,
    todoPhases: [{ name: "Fixture progress", tasks: [{ content: "Exercise the desktop boundary", status: "completed" }] }],
  });
  if (command.type === "get_available_commands") return response({ commands: availableCommands });
  if (command.type === "get_available_models") return response({ models: modelOptions });
  if (command.type === "get_login_providers") return response({
    providers: [
      { id: "openai-codex", name: "ChatGPT Plus/Pro", available: true, authenticated },
      { id: "google-gemini-cli", name: "Google Gemini CLI", available: true, authenticated: false },
      { id: "github-copilot", name: "GitHub Copilot", available: false, authenticated: false },
    ],
  });
  if (command.type === "get_settings") return response({ settings: agentSettings });
  if (command.type === "set_setting") {
    const index = agentSettings.findIndex(setting => setting.path === command.path);
    if (index < 0) return response(undefined, false);
    agentSettings = agentSettings.map((setting, settingIndex) => settingIndex === index ? { ...setting, value: command.value } : setting);
    return response({ setting: agentSettings[index] });
  }
  if (command.type === "login" && command.providerId === "openai-codex") {
    const promptId = `fixture-auth-${Date.now()}`;
    pendingAuth = { command, promptId };
    send({ type: "extension_ui_request", id: promptId, method: "input", title: "Paste the authorization code", placeholder: "fixture-code", sensitive: true });
    return;
  }
  if (command.type === "extension_ui_response" && pendingAuth?.promptId === command.id) {
    authenticated = typeof command.value === "string" && command.value.length > 0;
    if (authenticated && authStateFile) fs.writeFileSync(authStateFile, "authenticated\n", "utf8");
    response({ providerId: "openai-codex" }, true, pendingAuth.command.id, "login");
    pendingAuth = undefined;
    return;
  }
  if (command.type === "extension_ui_response" && pendingAgentPrompt?.promptId === command.id) {
    const promptCommand = pendingAgentPrompt.command;
    pendingAgentPrompt = undefined;
    emitPromptResult(promptCommand);
    return;
  }
  if (command.type === "logout" && command.providerId === "openai-codex") {
    authenticated = false;
    if (authStateFile) {
      try {
        fs.unlinkSync(authStateFile);
      } catch {}
    }
    return response({ providerId: "openai-codex" });
  }
  if (command.type === "get_messages_page") {
    const offset = command.cursor ? Number(command.cursor) : 0;
    let pageSize = Math.min(128, historyMessages.length - offset);
    let messages = historyMessages.slice(offset, offset + pageSize);
    while (messages.length > 1 && Buffer.byteLength(JSON.stringify({ messages }), "utf8") > 700 * 1024) {
      pageSize = Math.max(1, Math.floor(pageSize / 2));
      messages = historyMessages.slice(offset, offset + pageSize);
    }
    const nextOffset = offset + messages.length;
    return response({ messages, totalMessages: historyMessages.length, ...(nextOffset < historyMessages.length ? { nextCursor: String(nextOffset) } : {}) });
  }
  if (command.type === "get_messages") return response({ messages: historyMessages });
  if (command.type === "get_subagents") return response({ subagents: [{ id: "fixture-agent", agent: "Verifier", status: "completed", task: "Verify the fixture boundary", progress: { resolvedModel: "fixture-model", tokens: 42, recentOutput: ["verified"] } }] });
  if (command.type === "set_subagent_subscription") return response({ level: command.level });
  if (command.type === "get_subagent_messages") return response({ reset: command.fromByte > 8, nextByte: 16, messages: [{ role: "assistant", content: [{ type: "text", text: "Fixture collaborator transcript." }] }] });
  if (command.type === "set_model") {
    model = modelOptions.find(candidate => candidate.provider === command.provider && candidate.id === command.modelId) ?? model;
    return response(model);
  }
  if (command.type === "set_thinking_level") {
    thinkingLevel = command.level;
    return response();
  }
  if (command.type === "set_fast_mode") {
    fastModeEnabled = command.enabled;
    return response({ enabled: fastModeEnabled, active: fastModeEnabled });
  }
  if (command.type === "set_steering_mode") {
    steeringMode = command.mode;
    return response();
  }
  if (command.type === "set_follow_up_mode") {
    followUpMode = command.mode;
    return response();
  }
  if (command.type === "set_interrupt_mode") {
    interruptMode = command.mode;
    return response();
  }
  if (command.type === "set_auto_compaction") {
    autoCompactionEnabled = command.enabled;
    return response();
  }
  if (command.type === "set_auto_retry") {
    autoRetryEnabled = command.enabled;
    return response();
  }
  if (command.type === "set_session_name" || command.type === "steer" || command.type === "follow_up" || command.type === "abort") return response({ accepted: true });
  if (command.type === "prompt" && command.message === "/status") {
    response({ agentInvoked: false });
    send({ type: "command_output", text: "Fixture status: ready" });
    return;
  }
  if (command.type === "prompt" && command.message === "seed scroll fixture") {
    response({ agentInvoked: false });
    for (let index = 1; index <= 18; index += 1) {
      send({ type: "command_output", text: `Scroll fixture entry ${index}` });
    }
    return;
  }
  if (command.type === "prompt") {
    const promptId = `fixture-agent-prompt-${Date.now()}`;
    pendingAgentPrompt = { command, promptId };
    send({ type: "extension_ui_request", id: promptId, method: "input", title: "Administrator password", placeholder: "fixture-sudo", sensitive: true });
    return;
  }
  if (command.type === "prompt_result") return response({ agentInvoked: false });
  response(undefined, false);
});
input.on("close", () => process.exit(0));
