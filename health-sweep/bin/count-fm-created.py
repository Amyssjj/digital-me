#!/usr/bin/env python3
"""health-sweep truth helper — count knowledge-tree entries by frontmatter `created`.

Ground-truth side of the motus-data-sweep metric pairings: the flat trees at
~/digital-me/{wiki,tastes}/ ARE the primary source, and an entry's chronology is
its frontmatter `created` date (what the dashboard intake and the daily digest
must agree with). Stdlib-only, read-only.

  count-fm-created.py --root <dir> --since-days-utc N   # created >= (UTC today - N)
  count-fm-created.py --root <dir> --date YYYY-MM-DD    # created == date
  count-fm-created.py --root <dir>                      # all entries (any created)

Files whose basename starts with `_` (indexes/overviews) are never entries.
`--since-days-utc` mirrors the dashboard API's sqlite `date('now','-N days')`
cutoff (UTC), so a `?days=N` surface and this truth share one clock.
"""
from __future__ import annotations

import argparse
import datetime
import re
import sys
from pathlib import Path

FM_CREATED = re.compile(r"^created:\s*['\"]?(\d{4}-\d{2}-\d{2})", re.MULTILINE)
FM_BLOCK = re.compile(r"^---\n(.*?)\n---", re.DOTALL)


def created_of(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    m = FM_BLOCK.match(text)
    if not m:
        return None
    d = FM_CREATED.search(m.group(1))
    return d.group(1) if d else None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--since-days-utc", type=int, default=None)
    p.add_argument("--date", type=str, default=None)
    a = p.parse_args()
    if a.since_days_utc is not None and a.date is not None:
        print("--since-days-utc and --date are mutually exclusive", file=sys.stderr)
        return 2
    root = a.root.expanduser()
    if not root.is_dir():
        print(f"root missing: {root}", file=sys.stderr)
        return 2
    cutoff = (
        (datetime.datetime.now(datetime.timezone.utc).date()
         - datetime.timedelta(days=a.since_days_utc)).isoformat()
        if a.since_days_utc is not None else None
    )
    n = 0
    for md in root.rglob("*.md"):
        if md.name.startswith("_"):
            continue
        c = created_of(md)
        if c is None:
            continue
        if a.date is not None:
            n += c == a.date
        elif cutoff is not None:
            n += c >= cutoff
        else:
            n += 1
    print(n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
