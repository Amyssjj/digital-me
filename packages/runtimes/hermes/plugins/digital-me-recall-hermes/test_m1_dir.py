"""Unit tests for where the Hermes recall plugin writes M1 telemetry.

The WAL (m1_events_hermes.jsonl) and the session-aggregate log
(application_rate_hermes.log) live in the M1 dir, resolved by the same rule as
@digital-me/contracts resolveM1DirPath: $DIGITAL_ME_M1_DIR → <wiki-root>/.data/m1
when it exists → the legacy <OPENCLAW_HOME or ~/.openclaw>/data when it exists →
<wiki-root>/.data/m1. Resolved per write, so a long-lived Hermes switches to the
canonical dir as soon as it is created.

Run standalone:

    python3 packages/runtimes/hermes/plugins/digital-me-recall-hermes/test_m1_dir.py

or under pytest. Every test takes no fixtures so both runners call the same
functions.
"""

import contextlib
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from typing import Iterator

_spec = importlib.util.spec_from_file_location(
    "dmrh_m1_dir_under_test", Path(__file__).with_name("__init__.py")
)
dmrh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dmrh)

_ENV_KEYS = ("DIGITAL_ME_M1_DIR", "DIGITAL_ME_WIKI_ROOT", "OPENCLAW_HOME")


@contextlib.contextmanager
def _home(**env: str) -> Iterator[Path]:
    """A scratch HOME with only the given M1-relevant env vars set."""
    saved_env = {k: os.environ.get(k) for k in _ENV_KEYS}
    saved_home = dmrh.HOME
    with tempfile.TemporaryDirectory() as td:
        try:
            for k in _ENV_KEYS:
                os.environ.pop(k, None)
            os.environ.update(env)
            dmrh.HOME = Path(td)
            yield Path(td)
        finally:
            dmrh.HOME = saved_home
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


def test_fresh_machine_writes_canonical_never_openclaw():
    with _home() as home:
        assert dmrh._m1_dir() == home / "digital-me" / ".data" / "m1"


def test_legacy_dir_only_while_it_alone_exists():
    with _home() as home:
        legacy = home / ".openclaw" / "data"
        legacy.mkdir(parents=True)
        assert dmrh._m1_dir() == legacy
        canonical = home / "digital-me" / ".data" / "m1"
        canonical.mkdir(parents=True)
        assert dmrh._m1_dir() == canonical


def test_env_overrides():
    with _home(DIGITAL_ME_M1_DIR="/explicit/m1") as _:
        assert dmrh._m1_dir() == Path("/explicit/m1")
    with _home(DIGITAL_ME_M1_DIR="  ") as home:
        assert dmrh._m1_dir() == home / "digital-me" / ".data" / "m1"
    with _home() as home:
        os.environ["DIGITAL_ME_WIKI_ROOT"] = str(home / "w")
        os.environ["OPENCLAW_HOME"] = str(home / "oc")
        (home / "oc" / "data").mkdir(parents=True)
        assert dmrh._m1_dir() == home / "oc" / "data"
        (home / "w" / ".data" / "m1").mkdir(parents=True)
        assert dmrh._m1_dir() == home / "w" / ".data" / "m1"


def test_wal_append_and_seed_follow_the_resolved_dir():
    with _home() as home:
        canonical = home / "digital-me" / ".data" / "m1"
        canonical.mkdir(parents=True)
        dmrh._m1_wal_append({"event_type": "session_start", "session_id": "S-m1dir"})
        wal = canonical / "m1_events_hermes.jsonl"
        assert json.loads(wal.read_text(encoding="utf-8"))["session_id"] == "S-m1dir"
        assert not (home / ".openclaw").exists()
        dmrh._SESSION_M1_STARTED.discard("S-m1dir")
        assert dmrh._seed_session_m1_started_from_wal() == 1
        assert "S-m1dir" in dmrh._SESSION_M1_STARTED
        dmrh._SESSION_M1_STARTED.discard("S-m1dir")


def test_app_rate_record_lands_in_the_m1_dir():
    with _home() as home:
        legacy = home / ".openclaw" / "data"
        legacy.mkdir(parents=True)
        sid = "S-app-rate"
        with dmrh._STATE_LOCK:
            dmrh._SESSION_SURFACED[sid] = {"infra/a.md"}
            assert dmrh._write_app_rate_record(sid, "test", drop_after=True) is True
        rec = json.loads((legacy / "application_rate_hermes.log").read_text(encoding="utf-8"))
        assert rec["session_id"] == sid
        assert rec["surfaced_unique"] == 1


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
