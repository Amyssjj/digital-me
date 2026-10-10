"""Tests for the lossy-update guard on compile's `update_path` writes.

Regression (2026-10-08): the compiler agent failed auth, apply_compile's
inline fallback compiled every candidate, and `write_wiki_entry` overwrote
four existing entries with the LLM's from-scratch "revisions". A 105-line
deploy runbook came back as 24 lines — the 5-step ritual, the deploy scope
caveats, the manual-deploy recipe and the stale-shadow guidance were gone,
harmful advice ("git checkout -- STATE-LOG.md") was added, and the
frontmatter was reset to `citations: 0` / `source: claude-code-transcripts`.

The fixtures below are shaped like that entry and that rewrite.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from textwrap import dedent

import yaml

from dream_cycle import apply_compile
from dream_cycle import compile as C
from dream_cycle.config import load_config

REL = "development/digital-me-deploy-lifecycle-merge-is-not-deployed.md"
MANIFEST = f"- [?] {REL}: The global CLI is chained to a mutable checkout"

EXISTING_ENTRY = dedent("""\
    ---
    title: The global CLI is chained to a mutable checkout — "merged" is NOT "deployed"
    domain:
    - development
    - infrastructure
    tags:
    - deploy
    - lifecycle
    - git-hygiene
    priority: always
    citations: 3
    created: 2026-06-03
    updated: '2026-10-07'
    related:
    - development/dashboard-deploy-ritual.md
    source: claude-code
    learning_id: lrn-0000-fixture
    ---


    ## Rule
    The global CLI is a thin wrapper around ONE checkout, so the CLI's behavior
    equals the state of that checkout. Two failure axes and one hygiene rule:

    1. **Merged to git is not deployed.** After a PR merges, the running system
       still reflects the OLD code until you run the full ritual:
       ```bash
       git -C ~/digital-me-os pull --ff-only          # 1. sync source
       pnpm -C ~/digital-me-os build                  # 2. rebuild deps + CLI
       digital-me install --runtime openclaw          # 3. deploy to the state dir
       launchctl kickstart -k gui/501/ai.gateway      # 4. restart the gateway
       # 5. verify: registration marker in the gateway log + a live health probe
       ```
       `dist/` is git-ignored build output — `git pull` alone never refreshes it.

    2. **Keep the deploy source pristine.** Never hand-edit the checkout the CLI
       runs from; make changes in a worktree and merge them.

    3. **Health-sweep re-dirties the tracked STATE-LOG daily.** Commit the
       append-only run records (merge, never reset) before deploying — they are
       real history, not scratch output.

    ## What `digital-me deploy` covers
    - It pulls, builds and restarts the gateway and the dashboard.
    - It does NOT restart brain-host or the HTTP MCP proxy; deploy those by hand.
    - It refuses a dirty tree on purpose — clean the tree, don't bypass the check.

    ## brain-host manual deploy
    ```bash
    pnpm -C ~/digital-me-os build
    launchctl kickstart -k gui/501/ai.digital-me.brain-host
    curl -s localhost:18791/health
    ```

    ## Stale shadows
    If the deploy source is dirty with changes that are already on main, they
    are stale shadows of merged work: diff against origin/main, confirm, then
    discard. Anything not on main is real work — move it to a branch first.

    ## How it came up
    2026-06-03: a merged plugin fix "didn't work" for a day because the gateway
    still loaded the old build. 2026-10-07: deploy kept refusing because the
    health sweep had appended run records to the tracked STATE-LOG.

    ## Apply when
    - "merged but not live", "fix isn't taking effect after merge"
    - Running `digital-me deploy`, or it refuses with a dirty tree
    - Deploying brain-host or the HTTP MCP proxy by hand
""")

# The 2026-10-08 rewrite, minus the incidental wording: retitled, metadata
# reset, three sections dropped and harmful advice added.
LOSSY_REWRITE = dedent(f"""\
    ---
    update_path: {REL}
    title: The global digital-me CLI is chained to a mutable checkout
    domain: [development, infrastructure]
    tags: [digital-me-cli, deploy, lifecycle, git-hygiene, state-log]
    priority: search
    citations: 0
    created: 2026-06-03
    updated: 2026-10-08
    related: []
    source: claude-code-transcripts
    ---

    ## Rule
    The global CLI is a thin wrapper around a specific checkout.

    1. **Merged to git is not deployed.** After a PR merges, pull, rebuild, and restart the gateway.
    2. **Handle "dirty" log files before deploy.** Use `git checkout -- health-sweep/STATE-LOG.md` to clear these before running the deploy ritual.
    3. **Never hand-edit the deploy source.** Use worktrees for changes.

    ## How it came up
    In October 2026, `digital-me deploy` failed repeatedly because the STATE-LOG was dirtied.

    ## Apply when
    Running the deployment ritual. Search for: "deploy fails dirty tree", "merged but not live".
""")


def _additive_update() -> str:
    """A well-formed update: the existing body in full plus one new fact,
    with the downgraded metadata an LLM typically emits."""
    _, body = C._split_entry_text(EXISTING_ENTRY)
    body = body.replace(
        "## How it came up",
        "- A deploy also needs `digital-me doctor` green before it counts as done.\n\n"
        "## How it came up",
    )
    return dedent(f"""\
        ---
        update_path: {REL}
        title: Some new LLM title for the same entry
        domain: [development, operations]
        tags: [deploy, doctor]
        priority: search
        citations: 0
        created: {date.today().isoformat()}
        source: claude-code-transcripts
        route: tool=exec, params.command contains "digital-me deploy"
        ---
    """) + body


def _seed(fixture_wiki: Path) -> tuple[object, Path]:
    cfg = load_config(wiki_root=fixture_wiki)
    target = cfg.wiki_dir / REL
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(EXISTING_ENTRY, encoding="utf-8")
    return cfg, target


def _fm(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8").split("---", 2)[1])


def _refused_log(cfg) -> Path:
    return cfg.logs_dir / f"refused-updates-{date.today().isoformat()}.md"


# ── the incident shape ───────────────────────────────────────────────────────


def test_lossy_rewrite_of_deploy_runbook_is_refused(fixture_wiki: Path) -> None:
    cfg, target = _seed(fixture_wiki)

    stats = C.write_compiled_entries(
        cfg, [LOSSY_REWRITE], MANIFEST, source_name="claude-code-transcripts",
        source_title="Transcript: deploy session",
    )

    assert stats["refused_lossy_update"] == 1
    assert stats["updated"] == 0 and stats["new"] == 0
    assert stats["written_files"] == []
    # The existing entry is byte-for-byte untouched and nothing was added.
    assert target.read_text(encoding="utf-8") == EXISTING_ENTRY
    assert [p for p in cfg.wiki_dir.rglob("*.md")] == [target]

    # The proposal is kept for review, with where it would have gone and why.
    log = _refused_log(cfg).read_text(encoding="utf-8")
    assert f"wiki/{REL}" in log
    assert "drops section(s)" in log
    assert "What `digital-me deploy` covers" in log
    assert "Stale shadows" in log
    assert "of the existing body" in log
    assert "git checkout -- health-sweep/STATE-LOG.md" in log
    assert "Transcript: deploy session" in log


def test_inline_fallback_lossy_update_is_refused_and_hash_committed(
    fixture_wiki: Path, tmp_path: Path, monkeypatch,
) -> None:
    """Replays 2026-10-08: entries null → inline engine → update_path rewrite."""
    cfg, target = _seed(fixture_wiki)

    class FakeEngine:
        def llm_call(self, prompt: str, system: str = "") -> str:
            return LOSSY_REWRITE

    monkeypatch.setattr("dream_cycle.engine.get_engine", lambda config: FakeEngine())
    staging = tmp_path / "compile-staging.json"
    staging.write_text(json.dumps({
        "wiki_manifest": MANIFEST,
        "candidates": [
            {"content_key": "t:deploy", "source_name": "claude-code-transcripts",
             "title": "Transcript: deploy session", "prompt": "extract", "entries": None},
        ],
        "deferred_hashes": {"t:deploy": "h1"},
    }))

    stats = apply_compile.apply_entries(staging, cfg)

    assert stats["fallback_candidates"] == 1
    assert stats["refused_lossy_update"] == 1
    assert stats["updated"] == 0
    assert target.read_text(encoding="utf-8") == EXISTING_ENTRY
    # A refusal is a processed candidate (the proposal is in the review log),
    # so its hash commits like a noop instead of re-staging every night.
    assert stats["hashes_committed"] == 1
    assert C._load_compiled_hashes(cfg).get("t:deploy") == "h1"
    assert _refused_log(cfg).exists()


# ── updates that only add go through, without metadata downgrades ───────────


def test_additive_update_writes_and_never_downgrades_metadata(fixture_wiki: Path) -> None:
    cfg, target = _seed(fixture_wiki)

    stats = C.write_compiled_entries(cfg, [_additive_update()], MANIFEST)

    assert stats["updated"] == 1 and stats["refused_lossy_update"] == 0
    text = target.read_text(encoding="utf-8")
    assert "update_path" not in text
    # New fact landed; every existing section survived.
    assert "`digital-me doctor` green" in text
    for heading in C._section_headings(C._split_entry_text(EXISTING_ENTRY)[1]):
        assert f"## {heading}" in text

    fm = _fm(target)
    assert fm["title"].startswith("The global CLI is chained to a mutable checkout")
    assert fm["citations"] == 3
    assert fm["source"] == "claude-code"
    assert str(fm["created"]) == "2026-06-03"
    assert fm["priority"] == "always"
    assert fm["learning_id"] == "lrn-0000-fixture"
    assert fm["domain"] == ["development", "infrastructure", "operations"]
    assert fm["tags"] == ["deploy", "lifecycle", "git-hygiene", "doctor"]
    assert fm["related"] == ["development/dashboard-deploy-ritual.md"]
    assert fm["route"] == 'tool=exec, params.command contains "digital-me deploy"'
    assert fm["updated"] == date.today().isoformat()
    assert not _refused_log(cfg).exists()


def test_reflowed_update_is_not_lossy() -> None:
    """An LLM revision re-wraps lines freely; that alone loses nothing."""
    _, body = C._split_entry_text(EXISTING_ENTRY)
    reflowed = body.replace("behavior\nequals", "behavior equals").replace(
        "main, they\nare", "main,\nthey are",
    )
    assert reflowed != body
    assert C._body_retention(body, reflowed) == 1.0
    assert C._update_loss_reason(body, reflowed) is None


def test_renamed_section_is_refused_even_when_text_survives(fixture_wiki: Path) -> None:
    cfg, target = _seed(fixture_wiki)
    renamed = EXISTING_ENTRY.replace("## Stale shadows", "## Leftovers").replace(
        "---\ntitle:", f"---\nupdate_path: {REL}\ntitle:", 1,
    )

    stats = C.write_compiled_entries(cfg, [renamed], MANIFEST)

    assert stats["refused_lossy_update"] == 1
    assert target.read_text(encoding="utf-8") == EXISTING_ENTRY
    assert "drops section(s): Stale shadows" in _refused_log(cfg).read_text(encoding="utf-8")


def test_unparseable_update_frontmatter_is_refused(fixture_wiki: Path) -> None:
    cfg, target = _seed(fixture_wiki)
    broken = f"---\nupdate_path: {REL}\ntitle: [unclosed\n---\n\n## Rule\nx\n"

    stats = C.write_compiled_entries(cfg, [broken], MANIFEST)

    assert stats["refused_lossy_update"] == 1
    assert target.read_text(encoding="utf-8") == EXISTING_ENTRY


def test_update_of_entry_without_frontmatter_is_refused(fixture_wiki: Path) -> None:
    cfg, target = _seed(fixture_wiki)
    target.write_text("## Rule\nA hand-written note with no frontmatter.\n", encoding="utf-8")

    stats = C.write_compiled_entries(cfg, [LOSSY_REWRITE], MANIFEST)

    assert stats["refused_lossy_update"] == 1
    assert "existing entry has no parseable frontmatter" in _refused_log(cfg).read_text(encoding="utf-8")


def test_inline_run_compile_counts_refused_update(fixture_wiki: Path, monkeypatch) -> None:
    cfg, target = _seed(fixture_wiki)

    class FakeEngine:
        def llm_call(self, prompt: str, system: str = "") -> str:
            return LOSSY_REWRITE

    monkeypatch.setattr(C, "get_engine", lambda config: FakeEngine())
    monkeypatch.setattr(C, "build_principles_manifest", lambda: "")
    monkeypatch.setattr(C, "collect_raw_entries", lambda config, recent_days=None: [
        {"source_name": "notes", "title": "deploy note", "body": "b", "source_format": "frontmatter-md"},
    ])

    stats = C.run_compile(config=cfg)

    assert stats["refused_lossy_update"] == 1
    assert stats["updated"] == 0
    assert target.read_text(encoding="utf-8") == EXISTING_ENTRY


# ── helpers ──────────────────────────────────────────────────────────────────


def test_section_headings_ignore_fenced_code() -> None:
    _, body = C._split_entry_text(EXISTING_ENTRY)
    headings = C._section_headings(body + "\n```bash\n## not a heading\n```\n")
    assert "not a heading" not in headings
    assert headings == [
        "Rule", "What `digital-me deploy` covers", "brain-host manual deploy",
        "Stale shadows", "How it came up", "Apply when",
    ]


def test_merge_frontmatter_rules() -> None:
    merged = C._merge_update_frontmatter(
        {"title": "Old", "citations": 2, "tags": ["a"], "route": "", "source": "claude-code"},
        {"title": "New", "citations": "7", "tags": ["b", "a"], "route": "tool=exec",
         "source": "claude-code-transcripts", "status": "x"},
    )
    assert merged == {
        "title": "Old", "citations": 7, "tags": ["a", "b"], "route": "tool=exec",
        "source": "claude-code", "status": "x", "updated": date.today().isoformat(),
    }
    assert C._merge_update_frontmatter({"citations": 4}, {"citations": None})["citations"] == 4


def test_empty_existing_body_has_nothing_to_lose() -> None:
    assert C._body_retention("\n\n", "## Rule\nanything") == 1.0


def test_split_entry_text_rejects_non_frontmatter() -> None:
    assert C._split_entry_text("## Rule\nno frontmatter") is None
    assert C._split_entry_text("---\ntitle: never closed") is None
    assert C._split_entry_text("---\n- a list, not a mapping\n---\nbody") is None


def test_wiki_relpath_outside_wiki_root(fixture_wiki: Path, tmp_path: Path) -> None:
    cfg = load_config(wiki_root=fixture_wiki)
    outside = tmp_path / "elsewhere.md"
    assert C._wiki_relpath(cfg, outside) == outside
    assert C._wiki_relpath(cfg, cfg.wiki_dir / REL) == Path("wiki") / REL
