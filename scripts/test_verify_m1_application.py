"""verify_m1_application reads the per-runtime WALs from the M1 dir — the same
rule as @digital-me/contracts resolveM1DirPath — so the nightly runtime sweep
keeps seeing events once they move out of ~/.openclaw/data."""

import importlib.util
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "verify_m1_application_under_test", Path(__file__).with_name("verify_m1_application.py")
)
vm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vm)


@pytest.fixture(autouse=True)
def _no_m1_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("DIGITAL_ME_M1_DIR", "DIGITAL_ME_WIKI_ROOT", "OPENCLAW_HOME"):
        monkeypatch.delenv(var, raising=False)


def test_default_m1_dir_rule(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    canonical = tmp_path / "digital-me" / ".data" / "m1"
    legacy = tmp_path / ".openclaw" / "data"
    assert vm.default_m1_dir(tmp_path) == canonical
    legacy.mkdir(parents=True)
    assert vm.default_m1_dir(tmp_path) == legacy
    canonical.mkdir(parents=True)
    assert vm.default_m1_dir(tmp_path) == canonical
    monkeypatch.setenv("DIGITAL_ME_M1_DIR", str(tmp_path / "explicit"))
    assert vm.default_m1_dir(tmp_path) == tmp_path / "explicit"


def test_read_wals_follows_the_m1_dir(tmp_path: Path) -> None:
    event = {"event_type": "knowledge_surfaced", "session_id": "S", "turn_id": "1", "t": 5}
    legacy = tmp_path / ".openclaw" / "data"
    legacy.mkdir(parents=True)
    (legacy / "m1_events_hermes.jsonl").write_text(json.dumps(event) + "\n", encoding="utf-8")
    assert [r[0] for r in vm._read_wals(tmp_path, 0)] == ["hermes"]

    canonical = tmp_path / "digital-me" / ".data" / "m1"
    canonical.mkdir(parents=True)
    (canonical / "m1_events_claude_code.jsonl").write_text(
        "\n" + "not json\n" + json.dumps(event) + "\n", encoding="utf-8"
    )
    assert [r[0] for r in vm._read_wals(tmp_path, 0)] == ["claude-code"]


def _wal_event(t_ms: int, event_type: str, runtime: str) -> str:
    return json.dumps({"runtime": runtime, "event_type": event_type, "session_id": "S",
                       "turn_id": str(t_ms), "t": t_ms, "ack_signal": "explicit_path"}) + "\n"


def test_retired_runtime_is_reported_but_never_fails(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    """openclaw surfaced last week and never acked (FAIL) and has been silent
    for days (STALLED); once it is --retired, neither fails the run."""
    from datetime import datetime, timedelta, timezone

    old_ms = int((datetime.now(timezone.utc) - timedelta(days=3)).timestamp() * 1000)
    m1 = tmp_path / "digital-me" / ".data" / "m1"
    m1.mkdir(parents=True)
    (m1 / "m1_events_openclaw.jsonl").write_text(
        _wal_event(old_ms, "knowledge_surfaced", "openclaw"), encoding="utf-8"
    )
    args = ["--home", str(tmp_path), "--brain-db", str(tmp_path / "none.db"), "--stale-hours", "24"]
    assert vm.main(args) == 1
    assert "UNHEALTHY: openclaw" in capsys.readouterr().out

    assert vm.main([*args, "--retired", "openclaw"]) == 0
    out = capsys.readouterr().out
    assert "retired (not checked)" in out
    assert "(retired)" in out
