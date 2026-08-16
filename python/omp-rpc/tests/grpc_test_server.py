from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, AsyncIterator

import grpc

from omp_rpc import omp_rpc_pb2, omp_rpc_pb2_grpc

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
_MISSING = object()


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def _usage() -> dict[str, Any]:
    return {
        "input": 1,
        "output": 1,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 2,
        "cost": {
            "input": 0.0,
            "output": 0.0,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
            "total": 0.0,
        },
    }


def _model_info(model_id: str, provider: str = "anthropic") -> dict[str, Any]:
    return {
        "id": model_id,
        "name": f"Model {model_id}",
        "api": "anthropic-messages",
        "provider": provider,
        "baseUrl": "https://api.anthropic.com",
        "reasoning": True,
        "input": ["text"],
        "cost": {"input": 1.0, "output": 2.0, "cacheRead": 0.0, "cacheWrite": 0.0},
        "contextWindow": 200000,
        "maxTokens": 8192,
    }


def _response(
    request_id: str,
    command: str,
    data: object = _MISSING,
    *,
    success: bool = True,
    error: str | object = _MISSING,
    code: str | object = _MISSING,
) -> omp_rpc_pb2.ServerFrame:
    response = omp_rpc_pb2.Response(
        id=request_id,
        has_id=True,
        command=command,
        success=success,
    )
    if data is not _MISSING:
        response.data_json = _json_bytes(data)
        response.has_data = True
    if error is not _MISSING:
        response.error = str(error)
        response.has_error = True
    if code is not _MISSING:
        response.code = str(code)
        response.has_code = True
    return omp_rpc_pb2.ServerFrame(response=response)


def _push(frame_type: str, **payload: object) -> omp_rpc_pb2.ServerFrame:
    return omp_rpc_pb2.ServerFrame(
        push=omp_rpc_pb2.Push(type=frame_type, payload_json=_json_bytes(payload))
    )


class TestAgentService(omp_rpc_pb2_grpc.AgentServiceServicer):
    def __init__(self, token: str) -> None:
        self.token = token
        self.todo_phases: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []
        self.branch_messages = [{"entryId": "entry-1", "text": "branch message"}]
        self.model_provider = "anthropic"
        self.model_id = "claude-sonnet-4-5"
        self.thinking_level = "medium"
        self.steering_mode = "one-at-a-time"
        self.follow_up_mode = "one-at-a-time"
        self.interrupt_mode = "immediate"
        self.auto_compaction_enabled = True
        self.auto_retry_enabled = True
        self.session_name = "Scratchpad"
        self.last_assistant_text: str | None = None
        self.registered_host_tools: list[dict[str, Any]] = []
        self.host_event_tool_call_id = "toolu_host_1"
        self.host_event_tool_name = "echo_host"
        self.uri_request_id = 0

    async def Connect(
        self,
        request_iterator: AsyncIterator[omp_rpc_pb2.ClientFrame],
        context: grpc.aio.ServicerContext,
    ) -> AsyncIterator[omp_rpc_pb2.ServerFrame]:
        metadata = dict(context.invocation_metadata())
        authorization = metadata.get("authorization")
        expected = f"Bearer {self.token}"
        if authorization != expected:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "invalid bearer token")

        audit_file = os.environ.get("OMP_TEST_AUDIT_FILE")
        if audit_file:
            Path(audit_file).write_text(
                json.dumps(
                    {
                        "environment": {
                            name: os.environ.get(name)
                            for name in (
                                "OMP_GRPC_HOST",
                                "OMP_GRPC_PORT",
                                "OMP_GRPC_TOKEN",
                                "OMP_GRPC_READY_FILE",
                            )
                        },
                        "authorization": authorization,
                    }
                ),
                encoding="utf-8",
            )

        yield omp_rpc_pb2.ServerFrame(
            ready=omp_rpc_pb2.Ready(
                protocol_version=1,
                max_message_bytes=MAX_MESSAGE_BYTES,
            )
        )

        async for frame in request_iterator:
            kind = frame.WhichOneof("frame")
            if kind == "command":
                payload = json.loads(frame.command.payload_json or b"{}")
                async for outbound in self._handle_command(
                    frame.command.id, frame.command.name, payload
                ):
                    yield outbound
            elif kind == "push":
                payload = json.loads(frame.push.payload_json or b"{}")
                async for outbound in self._handle_client_push(frame.push.type, payload):
                    yield outbound

    def _assistant_message(self, text: str) -> dict[str, Any]:
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "api": "anthropic-messages",
            "provider": self.model_provider,
            "model": self.model_id,
            "usage": _usage(),
            "stopReason": "stop",
            "timestamp": 1,
        }

    def _current_state(self) -> dict[str, Any]:
        return {
            "model": _model_info(self.model_id, self.model_provider),
            "thinkingLevel": self.thinking_level,
            "isStreaming": False,
            "isCompacting": False,
            "steeringMode": self.steering_mode,
            "followUpMode": self.follow_up_mode,
            "interruptMode": self.interrupt_mode,
            "sessionId": "fake-session",
            "sessionName": self.session_name,
            "fastModeEnabled": False,
            "fastModeActive": True,
            "tokensPerSecond": 7.25,
            "autoCompactionEnabled": self.auto_compaction_enabled,
            "messageCount": len(self.messages),
            "queuedMessageCount": 0,
            "todoPhases": self.todo_phases,
            "dumpTools": [
                {"name": "read", "description": "Read files", "parameters": {"type": "object"}},
                *self.registered_host_tools,
            ],
        }

    async def _prompt_turn(
        self,
        text: str,
        *,
        delay: float = 0.0,
        include_extra_events: bool = False,
        compact_terminal: bool = False,
    ) -> AsyncIterator[omp_rpc_pb2.ServerFrame]:
        yield _push("agent_start")
        yield _push("turn_start")
        partial = self._assistant_message("")
        yield _push("message_start", message=partial)
        yield _push(
            "message_update",
            message=partial,
            assistantMessageEvent={
                "type": "text_delta",
                "contentIndex": 0,
                "delta": text,
                "partial": partial,
            },
        )
        if delay:
            await asyncio.sleep(delay)
        if include_extra_events:
            extras = (
                ("tool_execution_start", {"toolCallId": "tool-1", "toolName": "read", "args": {"path": "README.md"}, "intent": "Inspect docs"}),
                ("tool_execution_update", {"toolCallId": "tool-1", "toolName": "read", "args": {"path": "README.md"}, "partialResult": {"bytes": 12}}),
                ("tool_execution_end", {"toolCallId": "tool-1", "toolName": "read", "result": {"text": "docs"}, "isError": False}),
                ("auto_compaction_start", {"reason": "threshold", "action": "context-full"}),
                ("auto_compaction_end", {"action": "context-full", "result": {"summary": "trimmed", "shortSummary": "trimmed", "firstKeptEntryId": "entry-1", "tokensBefore": 123}, "aborted": False, "willRetry": False}),
                ("auto_retry_start", {"attempt": 1, "maxAttempts": 3, "delayMs": 25, "errorMessage": "retrying"}),
                ("auto_retry_end", {"success": True, "attempt": 1}),
                ("retry_fallback_applied", {"from": "a", "to": "b", "role": "primary"}),
                ("retry_fallback_succeeded", {"model": "b", "role": "primary"}),
                ("ttsr_triggered", {"rules": [{"id": "rule-1"}]}),
                ("todo_reminder", {"attempt": 1, "maxAttempts": 2, "todos": [{"id": "task-1", "content": "Map tools", "status": "pending"}]}),
                ("todo_auto_clear", {}),
            )
            for event_type, payload in extras:
                yield _push(event_type, **payload)
        assistant = self._assistant_message(text)
        yield _push("message_end", message=assistant)
        yield _push("turn_end", message=assistant, toolResults=[])
        if compact_terminal:
            terminal = self._assistant_message("terminal")
            yield _push("agent_end", messages=[terminal], messageCount=2)
            self.last_assistant_text = "terminal"
            self.messages = [assistant, terminal]
        else:
            yield _push("agent_end", messages=[assistant])
            self.last_assistant_text = text
            self.messages = [assistant]

    async def _handle_command(
        self, request_id: str, name: str, payload: dict[str, Any]
    ) -> AsyncIterator[omp_rpc_pb2.ServerFrame]:
        if name == "get_state":
            if os.environ.get("OMP_TEST_MISMATCH_RESPONSE") == "1":
                yield _response(request_id, "bash", {})
                return
            yield _response(request_id, name, self._current_state())
        elif name == "set_host_tools":
            self.registered_host_tools = payload.get("tools", [])
            yield _response(request_id, name, {"toolNames": [tool.get("name", "") for tool in self.registered_host_tools]})
        elif name == "set_host_uri_schemes":
            schemes = payload.get("schemes", [])
            yield _response(request_id, name, {"schemes": [entry.get("scheme", "") for entry in schemes]})
        elif name == "set_todos":
            self.todo_phases = payload.get("phases", [])
            yield _response(request_id, name, {"todoPhases": self.todo_phases})
        elif name == "get_messages":
            yield _response(request_id, name, {"messages": self.messages})
        elif name == "set_model":
            self.model_provider = payload["provider"]
            self.model_id = payload["modelId"]
            yield _response(request_id, name, _model_info(self.model_id, self.model_provider))
        elif name == "cycle_model":
            self.model_id = "claude-sonnet-4-6" if self.model_id == "claude-sonnet-4-5" else "claude-sonnet-4-5"
            yield _response(request_id, name, {"model": _model_info(self.model_id, self.model_provider), "thinkingLevel": self.thinking_level, "isScoped": False})
        elif name == "get_available_models":
            yield _response(request_id, name, {"models": [_model_info("claude-sonnet-4-5"), _model_info("claude-sonnet-4-6")]})
        elif name == "set_thinking_level":
            self.thinking_level = payload["level"]
            yield _response(request_id, name, {})
        elif name == "cycle_thinking_level":
            self.thinking_level = "high" if self.thinking_level != "high" else "low"
            yield _response(request_id, name, {"level": self.thinking_level})
        elif name == "set_steering_mode":
            self.steering_mode = payload["mode"]
            yield _response(request_id, name, {})
        elif name == "set_follow_up_mode":
            self.follow_up_mode = payload["mode"]
            yield _response(request_id, name, {})
        elif name == "set_interrupt_mode":
            self.interrupt_mode = payload["mode"]
            yield _response(request_id, name, {})
        elif name == "compact":
            yield _response(request_id, name, {"summary": "trimmed", "shortSummary": "trimmed", "firstKeptEntryId": "entry-1", "tokensBefore": 123})
        elif name == "set_fast_mode":
            yield _response(request_id, name, {"enabled": False, "active": True})
        elif name == "set_auto_compaction":
            self.auto_compaction_enabled = payload["enabled"]
            yield _response(request_id, name, {})
        elif name == "set_auto_retry":
            self.auto_retry_enabled = payload["enabled"]
            yield _response(request_id, name, {})
        elif name == "bash":
            yield _response(request_id, name, {"output": "hello\n", "exitCode": 0, "cancelled": False, "truncated": False, "totalLines": 1, "totalBytes": 6, "outputLines": 1, "outputBytes": 6})
        elif name == "get_session_stats":
            yield _response(request_id, name, {"sessionFile": "/tmp/fake-session", "sessionId": "fake-session", "userMessages": 1, "assistantMessages": len(self.messages), "toolCalls": 1, "toolResults": 1, "totalMessages": len(self.messages) + 1, "tokens": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "total": 15}, "premiumRequests": 0, "cost": 0.0})
        elif name == "export_html":
            yield _response(request_id, name, {"path": payload.get("outputPath") or "/tmp/session.html"})
        elif name in {"new_session", "switch_session"}:
            yield _response(request_id, name, {"cancelled": False})
        elif name == "branch":
            self.branch_messages = [{"entryId": payload["entryId"], "text": "branch message"}]
            yield _response(request_id, name, {"text": "branch created", "cancelled": False})
        elif name == "get_branch_messages":
            yield _response(request_id, name, {"messages": self.branch_messages})
        elif name == "get_last_assistant_text":
            yield _response(request_id, name, {"text": self.last_assistant_text})
        elif name == "set_session_name":
            self.session_name = payload["name"]
            yield _response(request_id, name, {})
        elif name in {"steer", "follow_up", "abort", "abort_retry", "abort_bash", "clear_todos"}:
            if name == "clear_todos":
                self.todo_phases = []
            yield _response(request_id, name, {})
        elif name in {"prompt", "abort_and_prompt"}:
            yield _response(request_id, name, {})
            message = payload["message"]
            if message == "hang":
                return
            if message == "needs ui":
                yield _push("extension_ui_request", id="ui-1", method="input", title="Need input", placeholder="value")
                return
            if message == "needs confirm":
                yield _push("extension_ui_request", id="ui-2", method="confirm", title="Confirm", message="Continue?")
                return
            if message == "needs cancel":
                yield _push("extension_ui_request", id="ui-3", method="editor", title="Edit", placeholder="value")
                return
            if message in {"needs host tool", "needs xd host tool"}:
                yield _push("agent_start")
                if message == "needs xd host tool":
                    self.host_event_tool_call_id = "toolu_write_1"
                    self.host_event_tool_name = "write"
                    yield _push("tool_execution_start", toolCallId="toolu_write_1", toolName="write", args={"path": "xd://echo_host", "content": '{"message":"hello"}'})
                    call_id = "host-call-2"
                else:
                    self.host_event_tool_call_id = "toolu_host_1"
                    self.host_event_tool_name = "echo_host"
                    call_id = "host-call-1"
                yield _push("host_tool_call", id=call_id, toolCallId=self.host_event_tool_call_id, toolName="echo_host", arguments={"message": "hello"})
                return
            if message == "notifications":
                yield _push("extension_error", extensionPath="/tmp/ext.py", event="run", error="boom")
                yield _push("unknown_future_event", value=1)
            async for event in self._prompt_turn(
                "pong",
                delay=0.3 if message == "slow" else 0.0,
                include_extra_events=message == "all events",
                compact_terminal=message == "compacted turn",
            ):
                yield event
        elif name == "trigger_read":
            self.uri_request_id += 1
            yield _push("host_uri_request", id=f"uri-req-{self.uri_request_id}", operation="read", url=payload["url"])
            yield _response(request_id, name, {})
        elif name == "trigger_write":
            self.uri_request_id += 1
            yield _push("host_uri_request", id=f"uri-req-{self.uri_request_id}", operation="write", url=payload["url"], content=payload["content"])
            yield _response(request_id, name, {})
        elif name == "empty_optional_error":
            yield _response(request_id, name, success=False, error="", code="")
        else:
            yield _response(request_id, name, success=False, error=f"unsupported: {name}")

    async def _handle_client_push(
        self, frame_type: str, payload: dict[str, Any]
    ) -> AsyncIterator[omp_rpc_pb2.ServerFrame]:
        if frame_type == "extension_ui_response":
            async for event in self._prompt_turn("ui acknowledged"):
                yield event
        elif frame_type == "host_tool_update":
            yield _push("tool_execution_update", toolCallId=self.host_event_tool_call_id, toolName=self.host_event_tool_name, args={"message": "hello"}, partialResult=payload["partialResult"])
        elif frame_type == "host_tool_result":
            yield _push("tool_execution_end", toolCallId=self.host_event_tool_call_id, toolName=self.host_event_tool_name, result=payload["result"], isError=payload.get("isError", False))
            yield _push("agent_end", messages=[])
        elif frame_type == "host_uri_result":
            yield _push("uri_echo", frame={"type": frame_type, **payload})


async def _main() -> None:
    host = os.environ["OMP_GRPC_HOST"]
    requested_port = int(os.environ["OMP_GRPC_PORT"])
    token = os.environ["OMP_GRPC_TOKEN"]
    ready_file = Path(os.environ["OMP_GRPC_READY_FILE"])


    server = grpc.aio.server(
        options=(
            ("grpc.max_send_message_length", MAX_MESSAGE_BYTES),
            ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
        )
    )
    omp_rpc_pb2_grpc.add_AgentServiceServicer_to_server(TestAgentService(token), server)
    port = server.add_insecure_port(f"{host}:{requested_port}")
    await server.start()

    bootstrap = {
        "protocol": "grpc",
        "protocolVersion": 1,
        "host": host,
        "port": port,
        "token": token,
        "maxMessageBytes": MAX_MESSAGE_BYTES,
    }
    if os.environ.get("OMP_TEST_BAD_BOOTSTRAP") == "1":
        bootstrap["protocol"] = "invalid"
    pending_ready_file = ready_file.with_suffix(".tmp")
    pending_ready_file.write_text(json.dumps(bootstrap), encoding="utf-8")
    pending_ready_file.chmod(0o600)
    pending_ready_file.replace(ready_file)
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(_main())
