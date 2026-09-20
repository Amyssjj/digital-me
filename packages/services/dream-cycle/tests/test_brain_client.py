"""Unit tests for brain_client. Uses a mocked fetcher so no live gateway
required. The fetcher receives (url, body, headers, timeout_s) and returns
the bytes a real gateway would have returned.

For end-to-end validation against a real openclaw gateway, see
docs/dream-cycle-spawn-dispatch-experiment.md.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from dream_cycle.brain_client import (
    BrainClient,
    BrainClientError,
    DEFAULT_PORT,
    GatewayEndpoint,
    load_gateway,
)


# ── load_gateway: arg → env → file resolution ─────────────────────────────


def test_load_gateway_defaults_when_env_and_file_empty(tmp_path: Path) -> None:
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"auth": {"token": "tok123"}}})
    )
    gw = load_gateway(env={}, openclaw_home=tmp_path)
    assert gw.host == "localhost"
    assert gw.port == DEFAULT_PORT
    assert gw.token == "tok123"
    assert gw.url == f"http://localhost:{DEFAULT_PORT}/tools/invoke"


def test_load_gateway_env_overrides_file(tmp_path: Path) -> None:
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"port": 19000, "auth": {"token": "file-tok"}}})
    )
    gw = load_gateway(
        env={
            "OPENCLAW_GATEWAY_HOST": "10.0.0.1",
            "OPENCLAW_GATEWAY_PORT": "20000",
            "OPENCLAW_GATEWAY_TOKEN": "env-tok",
        },
        openclaw_home=tmp_path,
    )
    assert gw.host == "10.0.0.1"
    assert gw.port == 20000
    assert gw.token == "env-tok"


def test_load_gateway_falls_back_to_password_field(tmp_path: Path) -> None:
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"auth": {"password": "legacy-pw"}}})
    )
    gw = load_gateway(env={}, openclaw_home=tmp_path)
    assert gw.token == "legacy-pw"


def test_load_gateway_errors_without_token(tmp_path: Path) -> None:
    (tmp_path / "openclaw.json").write_text(json.dumps({"gateway": {"port": 18789}}))
    with pytest.raises(BrainClientError, match="auth token not found"):
        load_gateway(env={}, openclaw_home=tmp_path)


def test_load_gateway_errors_on_invalid_port(tmp_path: Path) -> None:
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"auth": {"token": "tok"}}})
    )
    with pytest.raises(BrainClientError, match="not an integer"):
        load_gateway(
            env={"OPENCLAW_GATEWAY_PORT": "not-a-number"}, openclaw_home=tmp_path
        )


def test_load_gateway_handles_missing_openclaw_file(tmp_path: Path) -> None:
    """Fresh-user setup: no openclaw.json, but env supplies the token."""
    gw = load_gateway(
        env={"OPENCLAW_GATEWAY_TOKEN": "env-only"}, openclaw_home=tmp_path
    )
    assert gw.token == "env-only"
    assert gw.port == DEFAULT_PORT


# ── load_gateway: DIGITAL_ME_BRAIN_URL/TOKEN (brain-host) wins over openclaw ──


BRAIN_URL = "http://127.0.0.1:18791/tools/invoke"


def test_load_gateway_brain_url_wins_over_openclaw_env(tmp_path: Path) -> None:
    """brain-host env beats BOTH the OPENCLAW_GATEWAY_* env and openclaw.json —
    mirrors packages/transport/brain-mcp-proxy/src/config.ts."""
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"port": 19000, "auth": {"token": "file-tok"}}})
    )
    gw = load_gateway(
        env={
            "DIGITAL_ME_BRAIN_URL": BRAIN_URL,
            "DIGITAL_ME_BRAIN_TOKEN": "bt",
            "OPENCLAW_GATEWAY_HOST": "10.0.0.1",
            "OPENCLAW_GATEWAY_PORT": "20000",
            "OPENCLAW_GATEWAY_TOKEN": "env-tok",
        },
        openclaw_home=tmp_path,
    )
    assert gw.url == BRAIN_URL
    assert gw.token == "bt"
    assert gw.host == "127.0.0.1"
    assert gw.port == 18791


def test_load_gateway_brain_url_without_token_errors(tmp_path: Path) -> None:
    """URL without token is a hard error — never a silent fallback to openclaw,
    even when openclaw.json would have supplied a working token."""
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"auth": {"token": "file-tok"}}})
    )
    with pytest.raises(BrainClientError, match="DIGITAL_ME_BRAIN_TOKEN is not"):
        load_gateway(env={"DIGITAL_ME_BRAIN_URL": BRAIN_URL}, openclaw_home=tmp_path)


def test_load_gateway_brain_url_blank_token_errors(tmp_path: Path) -> None:
    """A whitespace-only token counts as unset."""
    with pytest.raises(BrainClientError, match="DIGITAL_ME_BRAIN_TOKEN is not"):
        load_gateway(
            env={"DIGITAL_ME_BRAIN_URL": BRAIN_URL, "DIGITAL_ME_BRAIN_TOKEN": "   "},
            openclaw_home=tmp_path,
        )


@pytest.mark.parametrize("bad_url", ["not-a-url", "ftp://x:1/tools/invoke", "http://"])
def test_load_gateway_brain_url_invalid_errors(tmp_path: Path, bad_url: str) -> None:
    with pytest.raises(BrainClientError, match="not a valid URL"):
        load_gateway(
            env={"DIGITAL_ME_BRAIN_URL": bad_url, "DIGITAL_ME_BRAIN_TOKEN": "bt"},
            openclaw_home=tmp_path,
        )


def test_load_gateway_brain_url_bad_port_errors(tmp_path: Path) -> None:
    with pytest.raises(BrainClientError, match="invalid port"):
        load_gateway(
            env={
                "DIGITAL_ME_BRAIN_URL": "http://127.0.0.1:99999/tools/invoke",
                "DIGITAL_ME_BRAIN_TOKEN": "bt",
            },
            openclaw_home=tmp_path,
        )


def test_load_gateway_brain_url_never_reads_openclaw_file(tmp_path: Path) -> None:
    """An INVALID openclaw.json would raise 'failed to read' via
    _read_openclaw_file — proving the brain-host branch resolves first and
    the openclaw file is never touched when DIGITAL_ME_BRAIN_* is set."""
    (tmp_path / "openclaw.json").write_text("{ this is not json")
    gw = load_gateway(
        env={"DIGITAL_ME_BRAIN_URL": BRAIN_URL, "DIGITAL_ME_BRAIN_TOKEN": "bt"},
        openclaw_home=tmp_path,
    )
    assert gw.url == BRAIN_URL
    # Sanity: without the brain env the same file IS read and does fail.
    with pytest.raises(BrainClientError, match="failed to read"):
        load_gateway(env={}, openclaw_home=tmp_path)


@pytest.mark.parametrize(
    ("url", "host", "port"),
    [
        ("https://brain.example/tools/invoke", "brain.example", 443),
        ("http://brain.example/tools/invoke", "brain.example", 80),
        ("http://[::1]:18791/tools/invoke", "::1", 18791),
    ],
)
def test_load_gateway_brain_url_infers_port_from_scheme(
    tmp_path: Path, url: str, host: str, port: int
) -> None:
    """No explicit port → scheme default; the verbatim URL is still what's used."""
    gw = load_gateway(
        env={"DIGITAL_ME_BRAIN_URL": url, "DIGITAL_ME_BRAIN_TOKEN": "bt"},
        openclaw_home=tmp_path,
    )
    assert (gw.host, gw.port, gw.url) == (host, port, url)


def test_load_gateway_blank_brain_url_falls_through_to_openclaw(tmp_path: Path) -> None:
    """An empty/whitespace DIGITAL_ME_BRAIN_URL is 'unset' — legacy path runs."""
    (tmp_path / "openclaw.json").write_text(
        json.dumps({"gateway": {"auth": {"token": "file-tok"}}})
    )
    gw = load_gateway(
        env={"DIGITAL_ME_BRAIN_URL": "  ", "DIGITAL_ME_BRAIN_TOKEN": "ignored"},
        openclaw_home=tmp_path,
    )
    assert gw.token == "file-tok"
    assert gw.url == f"http://localhost:{DEFAULT_PORT}/tools/invoke"


def test_load_gateway_token_error_mentions_brain_host(tmp_path: Path) -> None:
    """The no-token hint must name the brain-host env contract, not only openclaw."""
    with pytest.raises(BrainClientError, match="DIGITAL_ME_BRAIN_URL"):
        load_gateway(env={}, openclaw_home=tmp_path)


def test_gateway_endpoint_url_prefers_invoke_url() -> None:
    full = GatewayEndpoint(
        host="h", port=1, token="t", invoke_url="http://x:9/tools/invoke"
    )
    assert full.url == "http://x:9/tools/invoke"
    # Legacy 3-arg constructor keeps building host:port form.
    legacy = GatewayEndpoint(host="h", port=1234, token="t")
    assert legacy.invoke_url is None
    assert legacy.url == "http://h:1234/tools/invoke"


def test_brain_client_posts_to_invoke_url_verbatim() -> None:
    """End-to-end through BrainClient: a full DIGITAL_ME_BRAIN_URL endpoint is
    what the fetcher receives, with the brain token as the bearer."""
    captured: dict[str, Any] = {}

    def fetcher(url, body, headers, timeout_s):
        captured["url"] = url
        captured["auth"] = headers["Authorization"]
        return json.dumps({"ok": True, "result": {"ok": True}}).encode("utf-8")

    gw = load_gateway(
        env={"DIGITAL_ME_BRAIN_URL": BRAIN_URL, "DIGITAL_ME_BRAIN_TOKEN": "bt"},
        openclaw_home=Path("/nonexistent-openclaw-home"),
    )
    BrainClient(gateway=gw, fetcher=fetcher).schedule_tick()
    assert captured["url"] == BRAIN_URL
    assert captured["auth"] == "Bearer bt"


# ── BrainClient: request shape + response handling ────────────────────────


def _make_client(*, response: dict[str, Any], captured: dict[str, Any]) -> BrainClient:
    """Return a BrainClient wired to a fetcher that captures the request +
    returns the given response."""

    def fetcher(url, body, headers, timeout_s):
        captured["url"] = url
        captured["body"] = json.loads(body)
        captured["headers"] = dict(headers)
        captured["timeout_s"] = timeout_s
        return json.dumps(response).encode("utf-8")

    return BrainClient(
        gateway=GatewayEndpoint(host="h", port=1234, token="tok"),
        fetcher=fetcher,
        timeout_s=10.0,
    )


def test_run_workflow_sends_expected_request_shape() -> None:
    captured: dict[str, Any] = {}
    client = _make_client(
        response={
            "ok": True,
            "result": {
                "ok": True,
                "goalId": "g-1",
                "goalName": "dream-cycle",
                "taskCount": 6,
                "readyTaskIds": ["t-compile"],
            },
        },
        captured=captured,
    )
    result = client.run_workflow(
        template_id="wf_dream_cycle_v2",
        variables={"wiki_root": "/tmp/w", "date": "2026-05-19"},
        force=True,
    )
    assert captured["url"] == "http://h:1234/tools/invoke"
    assert captured["headers"]["Authorization"] == "Bearer tok"
    assert captured["headers"]["Content-Type"] == "application/json"
    assert captured["body"] == {
        "tool": "tasks",
        # openclaw >= 2026.8.1 refuses /tools/invoke on a multi-agent host with
        # no explicit owner. Distinct from any args-level agent_id, which is
        # attribution rather than ownership.
        "agentId": "main",
        "args": {
            "action": "run_workflow",
            "templateId": "wf_dream_cycle_v2",
            "variables": {"wiki_root": "/tmp/w", "date": "2026-05-19"},
            "force": True,
        },
    }
    assert result["goalId"] == "g-1"
    assert result["taskCount"] == 6


def test_run_workflow_omits_optional_fields_when_unset() -> None:
    captured: dict[str, Any] = {}
    client = _make_client(
        response={"ok": True, "result": {"ok": True, "goalId": "g-2"}},
        captured=captured,
    )
    client.run_workflow(template_id="wf_x")
    assert captured["body"]["args"] == {
        "action": "run_workflow",
        "templateId": "wf_x",
    }


def test_import_workflow_stringifies_template() -> None:
    """The gateway's workflow_import action wants workflowJson as a string,
    NOT a dict — verify BrainClient does the JSON encoding."""
    captured: dict[str, Any] = {}
    client = _make_client(
        response={"ok": True, "result": {"ok": True, "message": "Imported wf_x"}},
        captured=captured,
    )
    client.import_workflow({"id": "wf_x", "name": "WF X", "steps": []})
    assert captured["body"]["tool"] == "tasks"
    args = captured["body"]["args"]
    assert args["action"] == "workflow_import"
    # workflowJson must be a STRING, not a dict.
    assert isinstance(args["workflowJson"], str)
    parsed = json.loads(args["workflowJson"])
    assert parsed == {"id": "wf_x", "name": "WF X", "steps": []}


def test_import_workflow_surfaces_builder_error() -> None:
    """If the builder rejects the workflow, gateway sends ok=false; client
    raises BrainClientError with the error message."""
    client = _make_client(
        response={"ok": False, "error": {"message": "missing required field: name"}},
        captured={},
    )
    with pytest.raises(BrainClientError, match="missing required field"):
        client.import_workflow({"id": "wf_x"})


def test_schedule_tick_posts_correct_action() -> None:
    captured: dict[str, Any] = {}
    client = _make_client(
        response={"ok": True, "result": {"dispatched": 2, "reconciled": 0}},
        captured=captured,
    )
    client.schedule_tick()
    assert captured["body"] == {"tool": "tasks", "agentId": "main", "args": {"action": "schedule_tick"}}


def test_task_status_sends_taskId_with_json_format() -> None:
    """`status` is sent with format=json so the host's handleStatusJson path
    populates details.json.task (the markdown path leaves details.json None).
    The mocked envelope mirrors what the MCP tool actually returns."""
    captured: dict[str, Any] = {}
    client = _make_client(
        response={
            "ok": True,
            "result": {
                "content": [{"type": "text", "text": "{\"task\": {...}}"}],
                "details": {"json": {"task": {"id": "t-1", "status": "running"}}},
            },
        },
        captured=captured,
    )
    payload = client.task_status("t-1")
    assert captured["body"]["args"] == {
        "action": "status",
        "taskId": "t-1",
        "format": "json",
    }
    assert payload["details"]["json"]["task"]["status"] == "running"


def test_goal_status_filters_board_by_id() -> None:
    """goal_status uses the `board` action and filters by goal id —
    `status` would reject a goalId param at the gateway."""
    captured: dict[str, Any] = {}
    client = _make_client(
        response={
            "ok": True,
            "result": {
                "details": {
                    "json": {
                        "goals": [
                            {"id": "g-x", "status": "running"},
                            {"id": "g-1", "status": "completed", "tasks": [{"id": "t-1"}]},
                        ]
                    }
                }
            },
        },
        captured=captured,
    )
    goal = client.goal_status("g-1")
    assert captured["body"]["args"] == {"action": "board", "format": "json"}
    assert goal is not None
    assert goal["status"] == "completed"
    assert goal["tasks"][0]["id"] == "t-1"


def test_goal_status_returns_none_when_goal_missing() -> None:
    client = _make_client(
        response={"ok": True, "result": {"details": {"json": {"goals": []}}}},
        captured={},
    )
    assert client.goal_status("g-1") is None


def test_goal_status_returns_none_when_payload_misshapen() -> None:
    """Defensive — the board response could be malformed; don't crash."""
    client = _make_client(
        response={"ok": True, "result": {"details": {"json": "not a dict"}}},
        captured={},
    )
    assert client.goal_status("g-1") is None


def test_invoke_raises_on_ok_false() -> None:
    client = _make_client(
        response={"ok": False, "error": {"message": "boom"}},
        captured={},
    )
    with pytest.raises(BrainClientError, match="boom"):
        client.run_workflow("wf_x")


def test_invoke_raises_on_missing_result() -> None:
    client = _make_client(response={"ok": True}, captured={})
    with pytest.raises(BrainClientError, match="missing 'result'"):
        client.run_workflow("wf_x")


def test_invoke_raises_on_non_json_body() -> None:
    def fetcher(url, body, headers, timeout_s):
        return b"<html>nginx error</html>"

    client = BrainClient(
        gateway=GatewayEndpoint(host="h", port=1234, token="tok"),
        fetcher=fetcher,
    )
    with pytest.raises(BrainClientError, match="non-JSON body"):
        client.run_workflow("wf_x")


# ── wait_for_goal polling ─────────────────────────────────────────────────


def _board_response(goals_field: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "ok": True,
        "result": {"details": {"json": {"goals": goals_field}}},
    }


def test_wait_for_goal_returns_immediately_on_terminal_status() -> None:
    client = _make_client(
        response=_board_response([{"id": "g-1", "status": "completed", "tasks": []}]),
        captured={},
    )
    sleeps: list[float] = []
    goal = client.wait_for_goal(
        "g-1",
        timeout_s=60.0,
        poll_interval_s=1.0,
        sleep=lambda s: sleeps.append(s),
        now=lambda: 0.0,
    )
    assert goal["status"] == "completed"
    assert sleeps == []  # never slept; first poll was terminal


def test_wait_for_goal_polls_until_terminal() -> None:
    call_count = {"n": 0}

    def fetcher(url, body, headers, timeout_s):
        call_count["n"] += 1
        status = "running" if call_count["n"] < 3 else "completed"
        return json.dumps(_board_response([{"id": "g-1", "status": status}])).encode(
            "utf-8"
        )

    client = BrainClient(
        gateway=GatewayEndpoint(host="h", port=1, token="t"), fetcher=fetcher
    )
    sleeps: list[float] = []
    clock = {"t": 0.0}

    def tick(s: float) -> None:
        sleeps.append(s)
        clock["t"] += s

    goal = client.wait_for_goal(
        "g-1", timeout_s=60.0, poll_interval_s=1.0,
        sleep=tick, now=lambda: clock["t"],
    )
    assert goal["status"] == "completed"
    assert call_count["n"] == 3
    assert sleeps == [1.0, 1.0]


def test_wait_for_goal_raises_on_timeout() -> None:
    def fetcher(url, body, headers, timeout_s):
        return json.dumps(_board_response([{"id": "g-1", "status": "running"}])).encode(
            "utf-8"
        )

    client = BrainClient(
        gateway=GatewayEndpoint(host="h", port=1, token="t"), fetcher=fetcher
    )
    clock = {"t": 0.0}

    def tick(s: float) -> None:
        clock["t"] += s

    with pytest.raises(BrainClientError, match="did not finish within"):
        client.wait_for_goal(
            "g-1", timeout_s=2.0, poll_interval_s=1.0,
            sleep=tick, now=lambda: clock["t"],
        )


def test_wait_for_goal_raises_when_goal_disappears() -> None:
    """If the goal vanishes from the board mid-poll, surface clearly
    rather than infinitely retrying."""
    client = _make_client(response=_board_response([]), captured={})
    with pytest.raises(BrainClientError, match="not found on the active board"):
        client.wait_for_goal(
            "g-1", timeout_s=10.0, poll_interval_s=1.0,
            sleep=lambda s: None, now=lambda: 0.0,
        )
