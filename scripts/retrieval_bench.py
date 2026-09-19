#!/usr/bin/env python3
"""Retrieval-quality benchmark for the brain's `memory_search` tool.

Backend-neutral: it only needs an HTTP endpoint that speaks the
`POST /tools/invoke` envelope (`{tool, agentId, args}` → `{ok, result}`)
and returns hits shaped like `{path, score, startLine?, snippet?}`. Today
that is the openclaw gateway; tomorrow it is the digital-me brain-host.
Run it once per backend, keep the JSON snapshots, and diff them.

Two query sets, built fresh on every run (nothing hand-curated to maintain):

  labeled   — sampled wiki entries; queries are the entry title and its
              first "Apply when" bullet; the expected hit is that entry.
              Measures correctness: hit@1 / hit@5 / hit@10 / MRR.
  observed  — the most recent distinct real `memory_search` queries recorded
              in brain.db traces. No ground truth; the snapshot records the
              ranking so a later run can measure consistency (overlap@k,
              same top-1) against it.

Usage
  python3 scripts/retrieval_bench.py --label openclaw-2026-09-19
  python3 scripts/retrieval_bench.py --label brain-host-v1 \
      --url http://127.0.0.1:18791/tools/invoke --token "$BRAIN_HOST_TOKEN" \
      --compare ~/digital-me/.data/retrieval-bench/openclaw-2026-09-19.json

Stdlib only. Read-only against brain.db. Never writes into the wiki.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

DEFAULT_LIMIT = 10
DEFAULT_SAMPLE = 150
DEFAULT_OBSERVED = 100
DEFAULT_WORKERS = 4
DEFAULT_TIMEOUT_S = 60.0
OBSERVED_WINDOW_DAYS = 90


# --------------------------------------------------------------------------
# Endpoint resolution (mirrors packages/transport/brain-mcp-proxy/src/config.ts)
# --------------------------------------------------------------------------


def _strip_json5(text: str) -> str:
    """Good-enough JSON5 → JSON: drop // and /* */ comments and trailing commas."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    text = re.sub(r",\s*([}\]])", r"\1", text)
    return text


def _read_openclaw_json(home: Path) -> dict[str, Any]:
    p = home / "openclaw.json"
    if not p.exists():
        return {}
    raw = p.read_text(encoding="utf-8")
    for candidate in (raw, _strip_json5(raw)):
        try:
            parsed = json.loads(candidate, strict=False)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            continue
    return {}


def resolve_endpoint(url: Optional[str], token: Optional[str]) -> tuple[str, str]:
    env = os.environ
    home = Path(env.get("OPENCLAW_HOME") or (Path.home() / ".openclaw"))
    cfg = _read_openclaw_json(home)
    gw = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}

    if not url:
        host = env.get("OPENCLAW_GATEWAY_HOST") or "localhost"
        port = env.get("OPENCLAW_GATEWAY_PORT") or gw.get("port") or 18789
        url = f"http://{host}:{port}/tools/invoke"

    if not token:
        token = env.get("OPENCLAW_GATEWAY_TOKEN")
    if not token:
        auth = gw.get("auth") if isinstance(gw.get("auth"), dict) else {}
        token = auth.get("token") or auth.get("password")
    if not token:
        sys.exit("no token: pass --token, set OPENCLAW_GATEWAY_TOKEN, or populate gateway.auth.token")
    return url, token


class Backend:
    def __init__(self, url: str, token: str, agent_id: str, corpus: Optional[str], limit: int, timeout: float,
                 agent: Optional[str] = None):
        self.url, self.token, self.agent_id = url, token, agent_id
        self.corpus, self.limit, self.timeout, self.agent = corpus, limit, timeout, agent

    def search(self, query: str) -> tuple[list[dict[str, Any]], float, Optional[str]]:
        args: dict[str, Any] = {"query": query, "limit": self.limit}
        if self.corpus:
            args["corpus"] = self.corpus
        if self.agent:
            args["agent"] = self.agent
        body = json.dumps({"tool": "memory_search", "agentId": self.agent_id, "args": args}).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return [], time.perf_counter() - t0, f"HTTP {e.code}: {e.read()[:200]!r}"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return [], time.perf_counter() - t0, f"transport: {e}"
        elapsed = time.perf_counter() - t0
        if not payload.get("ok", True) and payload.get("error"):
            return [], elapsed, f"gateway: {payload.get('error')}"
        body_obj = _extract_body(payload)
        if body_obj.get("unavailable") or body_obj.get("disabled") or body_obj.get("error"):
            return [], elapsed, f"search unavailable: {body_obj.get('error') or body_obj.get('warning') or 'disabled'}"
        return _extract_hits(body_obj), elapsed, None


def _extract_body(payload: dict[str, Any]) -> dict[str, Any]:
    """Unwrap the tool body whatever the envelope: result.details (structured, preferred),
    result.content[0].text (JSON string), result.results, or top-level."""
    result = payload.get("result", payload)
    if isinstance(result, dict) and isinstance(result.get("details"), dict):
        return result["details"]
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        for block in result["content"]:
            text = block.get("text") if isinstance(block, dict) else None
            if isinstance(text, str) and text.lstrip().startswith("{"):
                try:
                    inner = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(inner.get("results"), list) or inner.get("error"):
                    return inner
    return result if isinstance(result, dict) else {}


def _extract_hits(body: dict[str, Any]) -> list[dict[str, Any]]:
    hits = body.get("results")
    if not isinstance(hits, list):
        return []
    out = []
    for h in hits:
        if not isinstance(h, dict):
            continue
        out.append(
            {
                "path": normalize_path(str(h.get("path", ""))),
                "score": h.get("score"),
                "startLine": h.get("startLine"),
                "corpus": h.get("corpus") or h.get("source"),
            }
        )
    return out


def normalize_path(p: str) -> str:
    """Reduce any absolute/relative path to `wiki/<domain>/<file>.md` or `tastes/...`."""
    p = p.replace("\\", "/")
    for root in ("/wiki/", "/tastes/"):
        idx = p.rfind(root)
        if idx >= 0:
            return p[idx + 1 :]
    return p.lstrip("./")


# --------------------------------------------------------------------------
# Query sets
# --------------------------------------------------------------------------


@dataclass
class Query:
    qid: str
    query: str
    kind: str  # title | apply_when | observed
    expected: Optional[str] = None  # normalized wiki path
    domain: Optional[str] = None


_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


def _frontmatter_title(text: str) -> Optional[str]:
    m = _FM_RE.match(text)
    if not m:
        return None
    for line in m.group(1).splitlines():
        if line.startswith("title:"):
            t = line[len("title:") :].strip().strip("'\"")
            return t or None
    return None


def _apply_when_first_line(text: str) -> Optional[str]:
    m = re.search(r"^## Apply when\s*\n(.*?)(?=^## |\Z)", text, flags=re.S | re.M)
    if not m:
        return None
    for line in m.group(1).splitlines():
        s = line.strip().lstrip("-*").strip()
        if len(s) >= 15:
            return s[:300]
    return None


def build_labeled(wiki_root: Path, sample: int, seed: int) -> list[Query]:
    wiki = wiki_root / "wiki"
    files = sorted(
        p for p in wiki.glob("*/*.md") if not p.name.startswith("_") and p.name != "README.md"
    )
    if not files:
        sys.exit(f"no wiki entries under {wiki}")
    rng = random.Random(seed)
    picked = files if sample <= 0 or sample >= len(files) else rng.sample(files, sample)
    picked.sort()
    out: list[Query] = []
    for p in picked:
        text = p.read_text(encoding="utf-8", errors="replace")
        rel = "wiki/" + p.relative_to(wiki).as_posix()
        domain = p.parent.name
        title = _frontmatter_title(text)
        aw = _apply_when_first_line(text)
        stem = p.stem
        if title:
            out.append(Query(f"t:{stem}", title, "title", rel, domain))
        if aw:
            out.append(Query(f"a:{stem}", aw, "apply_when", rel, domain))
    return out


def build_observed(brain_db: Path, n: int) -> list[Query]:
    if not brain_db.exists():
        return []
    since_ms = int((time.time() - OBSERVED_WINDOW_DAYS * 86400) * 1000)
    uri = f"file:{brain_db}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True)
        rows = con.execute(
            "SELECT payload, t FROM traces WHERE kind='mcp_tool_call' AND t >= ? "
            "AND payload LIKE '%\"toolName\":\"memory_search\"%' ORDER BY t DESC LIMIT ?",
            (since_ms, n * 6),
        ).fetchall()
        con.close()
    except sqlite3.Error as e:
        print(f"warn: could not read traces from {brain_db}: {e}", file=sys.stderr)
        return []
    seen: set[str] = set()
    out: list[Query] = []
    for payload, _t in rows:
        try:
            q = json.loads(payload).get("query")
        except json.JSONDecodeError:
            continue
        if not isinstance(q, str):
            continue
        key = re.sub(r"\s+", " ", q.strip().lower())
        if len(key) < 8 or key in seen:
            continue
        seen.add(key)
        out.append(Query(f"o:{len(out):03d}", q.strip()[:500], "observed"))
        if len(out) >= n:
            break
    return out


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


@dataclass
class Row:
    qid: str
    kind: str
    query: str
    expected: Optional[str]
    domain: Optional[str]
    hits: list[dict[str, Any]]
    latency_s: float
    error: Optional[str] = None
    rank_strict: Optional[int] = None
    rank_lenient: Optional[int] = None


def _rank(hits: list[dict[str, Any]], accept: set[str]) -> Optional[int]:
    seen_paths: list[str] = []
    for h in hits:
        p = h["path"]
        if p in seen_paths:
            continue  # multiple chunks of one file count once
        seen_paths.append(p)
        if p in accept:
            return len(seen_paths)
    return None


def score_row(row: Row) -> None:
    if not row.expected:
        return
    strict = {row.expected}
    lenient = strict | {f"wiki/{row.domain}/_OVERVIEW.md"} if row.domain else strict
    row.rank_strict = _rank(row.hits, strict)
    row.rank_lenient = _rank(row.hits, lenient)


def summarize(rows: list[Row], limit: int) -> dict[str, Any]:
    labeled = [r for r in rows if r.expected]
    observed = [r for r in rows if not r.expected]
    lat = sorted(r.latency_s for r in rows if not r.error)

    def block(rs: list[Row], attr: str) -> dict[str, Any]:
        n = len(rs)
        if n == 0:
            return {"n": 0}
        ranks = [getattr(r, attr) for r in rs]
        hit = lambda k: sum(1 for x in ranks if x is not None and x <= k) / n  # noqa: E731
        mrr = sum(1.0 / x for x in ranks if x is not None) / n
        return {"n": n, "hit@1": round(hit(1), 4), "hit@5": round(hit(5), 4),
                f"hit@{limit}": round(hit(limit), 4), "mrr": round(mrr, 4)}

    by_kind = {}
    for kind in ("title", "apply_when"):
        rs = [r for r in labeled if r.kind == kind]
        by_kind[kind] = {"strict": block(rs, "rank_strict"), "lenient": block(rs, "rank_lenient")}

    return {
        "queries": len(rows),
        "errors": sum(1 for r in rows if r.error),
        "empty": sum(1 for r in rows if not r.error and not r.hits),
        "labeled": {"strict": block(labeled, "rank_strict"), "lenient": block(labeled, "rank_lenient"),
                    "by_kind": by_kind},
        "observed": {"n": len(observed), "empty": sum(1 for r in observed if not r.hits)},
        "latency_s": {
            "p50": round(statistics.median(lat), 3) if lat else None,
            "p95": round(lat[int(0.95 * (len(lat) - 1))], 3) if lat else None,
            "mean": round(statistics.fmean(lat), 3) if lat else None,
        },
    }


# --------------------------------------------------------------------------
# Comparison against a baseline snapshot
# --------------------------------------------------------------------------


def _unique_paths(hits: list[dict[str, Any]], k: int) -> list[str]:
    out: list[str] = []
    for h in hits:
        if h["path"] not in out:
            out.append(h["path"])
        if len(out) >= k:
            break
    return out


def compare(current: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    base_rows = {r["qid"]: r for r in baseline["rows"]}
    cur_rows = {r["qid"]: r for r in current["rows"]}
    shared = [q for q in cur_rows if q in base_rows and cur_rows[q]["query"] == base_rows[q]["query"]]
    obs = [q for q in shared if base_rows[q]["kind"] == "observed"]

    def overlap(k: int) -> Optional[float]:
        vals = []
        for q in obs:
            a, b = set(_unique_paths(base_rows[q]["hits"], k)), set(_unique_paths(cur_rows[q]["hits"], k))
            if a or b:
                vals.append(len(a & b) / len(a | b))
        return round(statistics.fmean(vals), 4) if vals else None

    same_top1 = None
    if obs:
        same = sum(
            1 for q in obs
            if _unique_paths(base_rows[q]["hits"], 1) == _unique_paths(cur_rows[q]["hits"], 1)
        )
        same_top1 = round(same / len(obs), 4)

    def delta(path: list[str]) -> dict[str, Any]:
        b, c = baseline["summary"], current["summary"]
        for key in path:
            b, c = b.get(key, {}), c.get(key, {})
        out = {}
        for m, v in c.items():
            if isinstance(v, (int, float)) and isinstance(b.get(m), (int, float)) and m != "n":
                out[m] = {"baseline": b[m], "current": v, "delta": round(v - b[m], 4)}
        return out

    return {
        "baseline_label": baseline.get("label"),
        "shared_queries": len(shared),
        "observed_consistency": {"n": len(obs), "overlap@5": overlap(5), "overlap@10": overlap(10),
                                 "same_top1": same_top1},
        "labeled_strict": delta(["labeled", "strict"]),
        "labeled_lenient": delta(["labeled", "lenient"]),
        "latency": delta(["latency_s"]),
    }


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", required=True, help="snapshot name, e.g. openclaw-2026-09-19")
    ap.add_argument("--url", help="tools/invoke endpoint (default: openclaw gateway from env/openclaw.json)")
    ap.add_argument("--token", help="bearer token (default: OPENCLAW_GATEWAY_TOKEN or openclaw.json)")
    ap.add_argument("--agent-id", default=os.environ.get("OPENCLAW_AGENT_ID") or "main",
                    help="caller agent id; the openclaw gateway rejects ids it does not know (default: $OPENCLAW_AGENT_ID or main — the only agent whose index was live on 2026-09-19)")
    ap.add_argument("--corpus", default=None, help="memory_search corpus arg (memory|wiki|all); default = tool default")
    ap.add_argument("--agent", default=os.environ.get("RETRIEVAL_BENCH_AGENT") or None,
                    help="memory_search `agent` arg: whose memory index to search (openclaw: e.g. main, coo). Default = backend default")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    ap.add_argument("--sample", type=int, default=DEFAULT_SAMPLE, help="wiki entries to sample (0 = all)")
    ap.add_argument("--observed", type=int, default=DEFAULT_OBSERVED, help="recent real queries to replay")
    ap.add_argument("--seed", type=int, default=20260919)
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    ap.add_argument("--wiki-root", default=os.environ.get("DIGITAL_ME_WIKI_ROOT") or str(Path.home() / "digital-me"))
    ap.add_argument("--brain-db", default=os.environ.get("DIGITAL_ME_BRAIN_DB") or os.environ.get("BRAIN_DB")
                    or str(Path(os.environ.get("OPENCLAW_HOME") or (Path.home() / ".openclaw")) / "data" / "brain.db"))
    ap.add_argument("--out-dir", default=None, help="snapshot dir (default: <wiki-root>/.data/retrieval-bench)")
    ap.add_argument("--compare", help="baseline snapshot JSON to diff against")
    ap.add_argument("--dry-run", action="store_true", help="build query sets, print counts, do not call the backend")
    args = ap.parse_args()

    wiki_root = Path(args.wiki_root).expanduser()
    queries = build_labeled(wiki_root, args.sample, args.seed) + build_observed(Path(args.brain_db).expanduser(), args.observed)
    n_lab = sum(1 for q in queries if q.expected)
    print(f"queries: {len(queries)} (labeled {n_lab}, observed {len(queries) - n_lab})", file=sys.stderr)
    if args.dry_run:
        for q in queries[:5]:
            print(f"  {q.qid}  [{q.kind}]  {q.query[:80]!r}  -> {q.expected}", file=sys.stderr)
        return 0

    url, token = resolve_endpoint(args.url, args.token)
    print(f"backend: {url}  corpus={args.corpus or 'default'}  limit={args.limit}", file=sys.stderr)
    backend = Backend(url, token, args.agent_id, args.corpus, args.limit, args.timeout, args.agent)

    def run(q: Query) -> Row:
        hits, elapsed, err = backend.search(q.query)
        row = Row(q.qid, q.kind, q.query, q.expected, q.domain, hits, round(elapsed, 3), err)
        score_row(row)
        return row

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        rows = list(ex.map(run, queries))
    wall = round(time.time() - t0, 1)

    summary = summarize(rows, args.limit)
    snapshot = {
        "label": args.label,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "backend": {"url": url, "corpus": args.corpus, "limit": args.limit, "agent_id": args.agent_id, "agent": args.agent},
        "config": {"sample": args.sample, "observed": args.observed, "seed": args.seed, "wiki_root": str(wiki_root)},
        "wall_s": wall,
        "summary": summary,
        "rows": [asdict(r) for r in rows],
    }
    if args.compare:
        baseline = json.loads(Path(args.compare).expanduser().read_text(encoding="utf-8"))
        snapshot["comparison"] = compare(snapshot, baseline)

    out_dir = Path(args.out_dir).expanduser() if args.out_dir else wiki_root / ".data" / "retrieval-bench"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{args.label}.json"
    out.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False), encoding="utf-8")

    print(json.dumps({"label": args.label, "wall_s": wall, "summary": summary,
                      **({"comparison": snapshot["comparison"]} if "comparison" in snapshot else {})},
                     indent=1, ensure_ascii=False))
    print(f"snapshot: {out}", file=sys.stderr)
    return 0 if summary["errors"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
