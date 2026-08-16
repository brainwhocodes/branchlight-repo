from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from omp_rpc import (
    RpcClient,
    RpcConcurrencyError,
    RpcCommandError,
    RpcError,
    RpcProcessExitError,
    RpcProtocolError,
    host_tool,
    omp_rpc_pb2,
)

SERVER_COMMAND = [sys.executable, "-u", str(Path(__file__).with_name("grpc_test_server.py"))]
MAX_MESSAGE_BYTES = 64 * 1024 * 1024


class RpcClientTests(unittest.TestCase):
    def make_client(self, **kwargs: object) -> RpcClient:
        return RpcClient(
            command=SERVER_COMMAND,
            startup_timeout=2.0,
            request_timeout=2.0,
            **kwargs,
        )

    def test_generated_frames_carry_json_as_bytes(self) -> None:
        command_payload = json.dumps({"message": "hello"}).encode("utf-8")
        frame = omp_rpc_pb2.ClientFrame(
            command=omp_rpc_pb2.Command(
                id="request-1",
                name="prompt",
                payload_json=command_payload,
                has_id=True,
            )
        )
        restored = omp_rpc_pb2.ClientFrame.FromString(frame.SerializeToString())

        self.assertEqual(restored.WhichOneof("frame"), "command")
        self.assertEqual(restored.command.payload_json, command_payload)
        self.assertTrue(restored.command.has_id)
        response = omp_rpc_pb2.Response(
            id="request-1",
            has_id=True,
            command="prompt",
            success=False,
            error="",
            has_error=True,
            code="",
            has_code=True,
        )
        restored_response = omp_rpc_pb2.Response.FromString(response.SerializeToString())
        self.assertTrue(restored_response.has_error)
        self.assertEqual(restored_response.error, "")
        self.assertTrue(restored_response.has_code)
        self.assertEqual(restored_response.code, "")
        service = omp_rpc_pb2.DESCRIPTOR.services_by_name["AgentService"]
        self.assertEqual(service.full_name, "omp.rpc.v1.AgentService")
        self.assertEqual(service.methods[0].name, "Connect")
        self.assertEqual(
            f"/{service.full_name}/{service.methods[0].name}",
            "/omp.rpc.v1.AgentService/Connect",
        )
        self.assertTrue(service.methods[0].client_streaming)
        self.assertTrue(service.methods[0].server_streaming)

    def test_bootstrap_environment_and_bearer_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as work:
            audit_file = Path(work, "audit.json")
            with self.make_client(env={"OMP_TEST_AUDIT_FILE": str(audit_file)}):
                audit = json.loads(audit_file.read_text(encoding="utf-8"))
                environment = audit["environment"]
                ready_file = Path(environment["OMP_GRPC_READY_FILE"])
                bootstrap = json.loads(ready_file.read_text(encoding="utf-8"))

                self.assertEqual(environment["OMP_GRPC_HOST"], "127.0.0.1")
                self.assertEqual(environment["OMP_GRPC_PORT"], "0")
                self.assertTrue(environment["OMP_GRPC_TOKEN"])
                self.assertEqual(
                    audit["authorization"],
                    f"Bearer {environment['OMP_GRPC_TOKEN']}",
                )
                self.assertEqual(
                    bootstrap,
                    {
                        "protocol": "grpc",
                        "protocolVersion": 1,
                        "host": "127.0.0.1",
                        "port": bootstrap["port"],
                        "token": environment["OMP_GRPC_TOKEN"],
                        "maxMessageBytes": MAX_MESSAGE_BYTES,
                    },
                )
                self.assertGreater(bootstrap["port"], 0)
                self.assertLessEqual(bootstrap["port"], 65535)
                self.assertEqual(ready_file.stat().st_mode & 0o777, 0o600)
            self.assertFalse(ready_file.exists())
            self.assertFalse(ready_file.parent.exists())

    def test_command_builder_supports_common_rpc_options(self) -> None:
        client = RpcClient(
            executable="omp",
            model="openrouter/anthropic/claude-sonnet-4.6",
            cwd="/tmp/workspace",
            thinking="high",
            append_system_prompt="extra instructions",
            provider_session_id="provider-session-1",
            tools=("read", "edit", "write"),
            no_session=True,
            no_skills=True,
            no_rules=True,
            extra_args=("--foo", "bar"),
        )
        self.assertEqual(
            client.command,
            (
                "omp",
                "--mode",
                "rpc",
                "--model",
                "openrouter/anthropic/claude-sonnet-4.6",
                "--thinking",
                "high",
                "--append-system-prompt",
                "extra instructions",
                "--provider-session-id",
                "provider-session-1",
                "--tools",
                "read,edit,write",
                "--no-session",
                "--no-skills",
                "--no-rules",
                "--no-title",
                "--foo",
                "bar",
            ),
        )

    def test_get_state_and_bash(self) -> None:
        with self.make_client() as client:
            state = client.get_state()
            self.assertEqual(state.session_id, "fake-session")
            self.assertEqual(state.model.id if state.model else None, "claude-sonnet-4-5")
            self.assertFalse(state.fast_mode_enabled)
            self.assertTrue(state.fast_mode_active)
            self.assertEqual(state.tokens_per_second, 7.25)

            result = client.bash("echo hello")
            self.assertEqual(result.output, "hello\n")
            self.assertEqual(result.exit_code, 0)

    def test_mismatched_response_command_fails_waiter_and_reports_protocol_error(
        self,
    ) -> None:
        with self.make_client(env={"OMP_TEST_MISMATCH_RESPONSE": "1"}) as client:
            with self.assertRaises(RpcProtocolError) as caught:
                client.get_state()
            protocol_errors = client.protocol_errors

        self.assertEqual(len(protocol_errors), 1)
        self.assertIs(protocol_errors[0], caught.exception)
        self.assertEqual(
            str(caught.exception),
            "RPC response command mismatch for id req_1: "
            "expected 'get_state', received 'bash'",
        )

    def test_set_fast_mode_preserves_provider_tier_state(self) -> None:
        with self.make_client() as client:
            result = client.set_fast_mode(False)
        self.assertFalse(result.enabled)
        self.assertTrue(result.active)

    def test_explicit_empty_error_and_code_preserve_presence(self) -> None:
        with self.make_client() as client:
            with self.assertRaises(RpcCommandError) as caught:
                client._request("empty_optional_error")

        self.assertEqual(caught.exception.error, "")
        self.assertEqual(caught.exception.code, "")


    def test_prompt_and_wait_returns_assistant_text(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("say hello", timeout=2.0)
        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertGreaterEqual(len(turn.events), 3)

    def test_prompt_and_wait_reconstructs_compacted_terminal_messages(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("compacted turn", timeout=2.0)
        self.assertEqual(
            [message["content"][0]["text"] for message in turn.messages],
            ["pong", "terminal"],
        )
        self.assertEqual(turn.require_assistant_text(), "terminal")

    def test_custom_tools_are_registered_and_executed_via_host_pushes(self) -> None:
        def echo_host(args: dict[str, str], context) -> str:
            context.send_update(f"working:{args['message']}")
            return f"host:{args['message']}"

        with self.make_client(
            custom_tools=(
                host_tool(
                    name="echo_host",
                    description="Echo from the Python host process",
                    parameters={
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                        "additionalProperties": False,
                    },
                    execute=echo_host,
                ),
            )
        ) as client:
            state = client.get_state()
            self.assertEqual(state.dump_tools[-1].name, "echo_host")
            turn = client.prompt_and_wait("needs host tool", timeout=2.0)

        updates = [
            event
            for event in turn.events
            if getattr(event, "type", None) == "tool_execution_update"
        ]
        endings = [
            event
            for event in turn.events
            if getattr(event, "type", None) == "tool_execution_end"
        ]
        self.assertEqual(updates[0].partial_result["content"][0]["text"], "working:hello")
        self.assertEqual(endings[0].result["content"][0]["text"], "host:hello")

    def test_device_dispatched_tool_events_use_host_tool_name(self) -> None:
        def echo_host(args: dict[str, str], context) -> str:
            context.send_update(f"working:{args['message']}")
            return f"host:{args['message']}"

        with self.make_client(
            custom_tools=(
                host_tool(
                    name="echo_host",
                    description="Echo from the Python host process",
                    parameters={"type": "object"},
                    execute=echo_host,
                ),
            )
        ) as client:
            turn = client.prompt_and_wait("needs xd host tool", timeout=2.0)

        starts = [event for event in turn.events if getattr(event, "type", None) == "tool_execution_start"]
        updates = [event for event in turn.events if getattr(event, "type", None) == "tool_execution_update"]
        endings = [event for event in turn.events if getattr(event, "type", None) == "tool_execution_end"]
        self.assertEqual([event.tool_name for event in starts], ["write"])
        self.assertEqual([event.tool_name for event in updates], ["echo_host"])
        self.assertEqual([event.tool_name for event in endings], ["echo_host"])
        self.assertEqual(endings[0].tool_call_id, "toolu_write_1")

    def test_rejected_host_tool_calls_do_not_rename_transport_events(self) -> None:
        client = self.make_client()
        rejected_results: list[dict[str, object]] = []
        calls = (
            {
                "type": "host_tool_call",
                "id": "bad-args",
                "toolCallId": "toolu_rejected_1",
                "toolName": "echo_host",
                "arguments": "not-an-object",
            },
            {
                "type": "host_tool_call",
                "id": "unknown-tool",
                "toolCallId": "toolu_rejected_2",
                "toolName": "missing_host_tool",
                "arguments": {},
            },
        )

        with patch.object(client, "_send_notification", rejected_results.append):
            for call in calls:
                client._handle_host_tool_call(call)
                transport_event = {
                    "type": "tool_execution_end",
                    "toolCallId": call["toolCallId"],
                    "toolName": "write",
                }
                client._normalize_host_tool_event(transport_event)
                self.assertEqual(transport_event["toolName"], "write")

        self.assertEqual(
            [(result["id"], result["isError"]) for result in rejected_results],
            [("bad-args", True), ("unknown-tool", True)],
        )

    def test_extension_ui_round_trip(self) -> None:
        with self.make_client() as client:
            client.prompt("needs ui")
            request = client.next_ui_request(timeout=2.0)
            self.assertEqual(request.method, "input")
            client.send_ui_value(request.id, "approved")
            client.wait_for_idle(timeout=2.0)

    def test_install_headless_ui_cancels_interactive_requests(self) -> None:
        seen_methods: list[str] = []
        with self.make_client() as client:
            client.install_headless_ui(
                on_request=lambda request: seen_methods.append(request.method)
            )
            client.prompt_and_wait("needs ui", timeout=2.0)
        self.assertEqual(seen_methods, ["input"])

    def test_ready_and_typed_event_listeners(self) -> None:
        ready_types: list[str] = []
        event_types: list[str] = []
        notification_types: list[str] = []
        client = self.make_client()
        client.on_ready(lambda event: ready_types.append(event.type))
        client.on_notification(lambda event: notification_types.append(event.type))
        client.on_turn_start(lambda event: event_types.append(event.type))
        client.on_message_update(lambda event: event_types.append(event.type))
        client.on_agent_end(lambda event: event_types.append(event.type))
        try:
            client.start()
            client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(ready_types, ["ready"])
        self.assertEqual(event_types, ["turn_start", "message_update", "agent_end"])
        self.assertIn("turn_start", notification_types)
        self.assertIn("agent_end", notification_types)

    def test_set_todos_supports_flat_items(self) -> None:
        with self.make_client() as client:
            phases = client.set_todos(["Map tools", "Exercise edits"])
            self.assertEqual(len(phases), 1)
            self.assertEqual(phases[0].name, "Todos")
            self.assertEqual(phases[0].tasks[0].content, "Map tools")
            self.assertEqual(phases[0].tasks[1].status, "pending")
            state = client.get_state()
            self.assertEqual(state.todo_phases[0].tasks[1].content, "Exercise edits")

    def test_model_mode_and_session_commands(self) -> None:
        with self.make_client() as client:
            model = client.set_model("anthropic", "claude-sonnet-4-6")
            self.assertEqual(model.id, "claude-sonnet-4-6")
            cycled = client.cycle_model()
            self.assertIsNotNone(cycled)
            self.assertEqual(cycled.model.id, "claude-sonnet-4-5")
            self.assertEqual(
                [item.id for item in client.get_available_models()],
                ["claude-sonnet-4-5", "claude-sonnet-4-6"],
            )

            client.set_thinking_level("high")
            self.assertEqual(client.get_state().thinking_level, "high")
            cycled_level = client.cycle_thinking_level()
            self.assertIsNotNone(cycled_level)
            self.assertEqual(cycled_level.level, "low")

            client.set_steering_mode("all")
            client.set_follow_up_mode("all")
            client.set_interrupt_mode("wait")
            client.set_auto_compaction(False)
            client.set_auto_retry(False)
            client.set_session_name("Renamed")
            state = client.get_state()
            self.assertEqual(state.steering_mode, "all")
            self.assertEqual(state.follow_up_mode, "all")
            self.assertEqual(state.interrupt_mode, "wait")
            self.assertFalse(state.auto_compaction_enabled)
            self.assertEqual(state.session_name, "Renamed")

            self.assertEqual(client.compact().summary, "trimmed")
            self.assertEqual(client.get_session_stats().tokens.total, 15)
            self.assertEqual(str(client.export_html("/tmp/custom.html")), "/tmp/custom.html")
            self.assertFalse(client.new_session().cancelled)
            self.assertFalse(client.switch_session("/tmp/session").cancelled)
            self.assertEqual(client.branch("entry-9").text, "branch created")
            self.assertEqual(client.get_branch_messages()[0].entry_id, "entry-9")

    def test_message_and_control_commands(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            self.assertEqual(turn.require_assistant_text(), "pong")
            self.assertEqual(client.get_last_assistant_text(), "pong")
            messages = client.get_messages()
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["role"], "assistant")

            client.clear_todos()
            self.assertEqual(client.get_todos(), ())
            client.steer("nudge")
            client.follow_up("later")
            client.abort()
            client.abort_retry()
            client.abort_bash()
            client.abort_and_prompt("say hello")
            client.wait_for_idle(timeout=2.0)
            self.assertEqual(client.get_last_assistant_text(), "pong")

    def test_collect_events_returns_turn_events(self) -> None:
        with self.make_client() as client:
            client.prompt("slow")
            events = client.collect_events(timeout=2.0)
        self.assertGreaterEqual(len(events), 1)
        self.assertEqual(events[-1].type, "agent_end")

    def test_all_typed_event_listeners_receive_eventful_prompt(self) -> None:
        seen: list[str] = []
        with self.make_client() as client:
            client.on_event(lambda event: seen.append(f"event:{event.type}"))
            client.on_agent_start(lambda event: seen.append(event.type))
            client.on_turn_end(lambda event: seen.append(event.type))
            client.on_message_start(lambda event: seen.append(event.type))
            client.on_message_end(lambda event: seen.append(event.type))
            client.on_tool_execution_start(lambda event: seen.append(event.type))
            client.on_tool_execution_update(lambda event: seen.append(event.type))
            client.on_tool_execution_end(lambda event: seen.append(event.type))
            client.on_auto_compaction_start(lambda event: seen.append(event.type))
            client.on_auto_compaction_end(lambda event: seen.append(event.type))
            client.on_auto_retry_start(lambda event: seen.append(event.type))
            client.on_auto_retry_end(lambda event: seen.append(event.type))
            client.on_retry_fallback_applied(lambda event: seen.append(event.type))
            client.on_retry_fallback_succeeded(lambda event: seen.append(event.type))
            client.on_ttsr_triggered(lambda event: seen.append(event.type))
            client.on_todo_reminder(lambda event: seen.append(event.type))
            client.on_todo_auto_clear(lambda event: seen.append(event.type))
            turn = client.prompt_and_wait("all events", timeout=2.0)

        self.assertEqual(turn.require_assistant_text(), "pong")
        for expected in (
            "agent_start",
            "message_start",
            "message_end",
            "turn_end",
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
            "auto_compaction_start",
            "auto_compaction_end",
            "auto_retry_start",
            "auto_retry_end",
            "retry_fallback_applied",
            "retry_fallback_succeeded",
            "ttsr_triggered",
            "todo_reminder",
            "todo_auto_clear",
        ):
            self.assertIn(expected, seen)

    def test_extension_and_unknown_notification_listeners(self) -> None:
        extension_errors: list[str] = []
        unknown: list[str] = []
        with self.make_client() as client:
            client.on_extension_error(lambda event: extension_errors.append(event.error))
            client.on_unknown_notification(
                lambda event: unknown.append(str(event.payload.get("type")))
            )
            client.prompt_and_wait("notifications", timeout=2.0)
        self.assertEqual(extension_errors, ["boom"])
        self.assertEqual(unknown, ["unknown_future_event"])

    def test_ui_confirmation_and_cancel_round_trip(self) -> None:
        with self.make_client() as client:
            client.prompt("needs confirm")
            confirmation = client.next_ui_request(timeout=2.0)
            self.assertEqual(confirmation.method, "confirm")
            client.send_ui_confirmation(confirmation.id, True)
            client.wait_for_idle(timeout=2.0)

            client.prompt("needs cancel")
            editor = client.next_ui_request(timeout=2.0)
            self.assertEqual(editor.method, "editor")
            client.cancel_ui_request(editor.id)
            client.wait_for_idle(timeout=2.0)

    def test_prompt_lifecycle_collectors_are_single_flight(self) -> None:
        results: list[str] = []
        errors: list[BaseException] = []
        with self.make_client() as client:
            def run_prompt() -> None:
                try:
                    results.append(
                        client.prompt_and_wait("slow", timeout=2.0).require_assistant_text()
                    )
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=run_prompt)
            thread.start()
            deadline = time.time() + 1.0
            while (
                client._prompt_lifecycle.active_operation != "prompt_and_wait"
                and time.time() < deadline
            ):
                time.sleep(0.01)
            self.assertEqual(client._prompt_lifecycle.active_operation, "prompt_and_wait")
            with self.assertRaises(RpcConcurrencyError):
                client.collect_events(timeout=1.0)
            thread.join(timeout=2.0)
            self.assertFalse(thread.is_alive())

        self.assertEqual(errors, [])
        self.assertEqual(results, ["pong"])

    def test_listener_mutation_does_not_change_retained_turn(self) -> None:
        with self.make_client() as client:
            client.on_message_end(
                lambda event: event.message["content"].__setitem__(
                    0, {"type": "text", "text": "mutated"}
                )
            )
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            messages = client.get_messages()
        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertEqual(messages[0]["content"][0]["text"], "pong")

    def test_listener_exceptions_are_reported_without_stopping_client(self) -> None:
        listener_errors: list[tuple[str, str | None, str]] = []
        client = self.make_client()
        client.on_notification(
            lambda notification: (
                (_ for _ in ()).throw(RuntimeError("boom"))
                if notification.type == "turn_start"
                else None
            )
        )
        client.on_listener_error(
            lambda event: listener_errors.append(
                (event.listener_kind, event.source_type, str(event.error))
            )
        )
        try:
            client.start()
            turn = client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()
        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertEqual(listener_errors, [("notification", "turn_start", "boom")])
        self.assertEqual(len(client.listener_errors), 1)


    def test_invalid_bootstrap_is_rejected(self) -> None:
        client = self.make_client(env={"OMP_TEST_BAD_BOOTSTRAP": "1"})
        with self.assertRaises(RpcError) as caught:
            client.start()
        self.assertIn("protocol", str(caught.exception).lower())

    def test_event_history_limit_reports_overflow(self) -> None:
        with self.make_client(max_event_history=2) as client:
            with self.assertRaises(RpcError) as caught:
                client.prompt_and_wait("say hello", timeout=2.0)
        self.assertIn("max_event_history", str(caught.exception))


class StopUnblocksPromptAndWaitTests(unittest.TestCase):
    def test_stop_during_prompt_unblocks_waiter(self) -> None:
        client = RpcClient(
            command=SERVER_COMMAND,
            startup_timeout=2.0,
            request_timeout=2.0,
        )
        outcome: list[BaseException] = []
        client.start()

        def wait_for_prompt() -> None:
            try:
                client.prompt_and_wait("hang", timeout=30.0)
            except BaseException as exc:
                outcome.append(exc)

        waiter = threading.Thread(target=wait_for_prompt)
        waiter.start()
        deadline = time.time() + 1.0
        while (
            client._prompt_lifecycle.active_operation != "prompt_and_wait"
            and time.time() < deadline
        ):
            time.sleep(0.01)
        client.stop()
        waiter.join(timeout=2.0)

        self.assertFalse(waiter.is_alive())
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], RpcProcessExitError)


if __name__ == "__main__":
    unittest.main()
