"""m1_cutover_verify reads the openclaw + hermes session logs from the M1 dir
(the @digital-me/contracts resolveM1DirPath rule), not a pinned ~/.openclaw/data."""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "m1_cutover_verify_under_test", Path(__file__).with_name("m1_cutover_verify.py")
)
cv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cv)


@pytest.fixture(autouse=True)
def _no_m1_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("DIGITAL_ME_M1_DIR", "DIGITAL_ME_WIKI_ROOT", "OPENCLAW_HOME"):
        monkeypatch.delenv(var, raising=False)


def test_resolve_m1_dir_rule(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    canonical = tmp_path / "digital-me" / ".data" / "m1"
    legacy = tmp_path / ".openclaw" / "data"
    assert cv._resolve_m1_dir(tmp_path) == canonical
    legacy.mkdir(parents=True)
    assert cv._resolve_m1_dir(tmp_path) == legacy
    canonical.mkdir(parents=True)
    assert cv._resolve_m1_dir(tmp_path) == canonical
    monkeypatch.setenv("DIGITAL_ME_M1_DIR", " ")
    assert cv._resolve_m1_dir(tmp_path) == canonical
    monkeypatch.setenv("DIGITAL_ME_M1_DIR", str(tmp_path / "x"))
    assert cv._resolve_m1_dir(tmp_path) == tmp_path / "x"


def test_hook_logs_live_in_the_m1_dir() -> None:
    assert cv.HOOK_LOGS["openclaw"] == cv.M1_DIR / "application_rate_openclaw.log"
    assert cv.HOOK_LOGS["hermes"] == cv.M1_DIR / "application_rate_hermes.log"
    assert cv.HOOK_LOGS["claude-code"] == cv.HOME / ".claude" / "hooks" / "application_rate.log"
