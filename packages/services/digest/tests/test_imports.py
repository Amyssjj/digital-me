"""Smoke: the package imports cleanly (no hardcoded path side-effects at import)."""


def test_import_package():
    import digest  # noqa: F401

    assert digest.__version__


def test_import_config():
    from digest import config  # noqa: F401

    assert hasattr(config, "load_paths")


def test_import_daily_digest():
    """Importing must not require any personal path to exist — module-level
    config resolution falls back to safe defaults."""
    from digest import daily_digest as dd

    assert callable(dd.main)
    assert callable(dd.validate_presentation)
    assert callable(dd.main_cli)


def test_schema_file_is_shipped():
    from pathlib import Path
    import json

    schema = Path(__file__).resolve().parent.parent / "src" / "digest" / "presentation.schema.json"
    assert schema.exists(), "presentation.schema.json must ship with the package"
    data = json.loads(schema.read_text())
    assert data["properties"]["blocks"]["items"]["properties"]["text"]["type"] == "string"
