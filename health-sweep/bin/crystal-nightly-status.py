#!/usr/bin/env python3
"""health-sweep ops helper — Crystal Core's nightly, read back as a step log.

`crystal nightly` runs as the LaunchAgent com.jingshi.crystal-nightly (daily
04:15, crystal-core scripts/nightly.sh: nightly, then verify) and appends to
~/Library/Logs/crystal/nightly.log. Nothing else reads that log or launchd's
exit code, so a failed night, a judge whose `claude` login expired, or a missing
backup would pass silently. This reads them and writes a derived step log the
ops capture scans like any other (profiles/ops.json stepLogs `crystal-nightly`):
one `## <check>` section per check, with `- error: …` when it fails, so each
check is its own O2 finding, overridable as `crystal-nightly#<check>`.

  fresh-run  the log's latest run started within --max-age-hours, its last line
             reads `done: nightly exit 0, verify exit 0`, and it printed
             `chain: ok` and `refold: identical`
  launchd    `launchctl print gui/<uid>/<label>` says `last exit code = 0`
  backup     <backups>/log-<today or yesterday>.db exists, and the latest run
             printed a `backup:` line
  judge      no `judge: answered N, failed M` line with M > 0 in the latest run
  pending    no <pending>/*.md older than --pending-max-age-hours

Read-only: it reads the log, the names, sizes and mtimes in the backups and
pending folders, and `launchctl print`; its only write is --out. The log and the
judgments quote Jing's words, so only fixed status lines are matched and only
times, exit codes, counts and file names go out, never a line's free text.
Stdlib-only, Python 3.9+ (`bash -lc` resolves python3 to /usr/bin/python3).

  crystal-nightly-status.py --out health-sweep/capture-crystal-nightly.md
      [--log ~/Library/Logs/crystal/nightly.log] [--max-age-hours 26]
      [--backups ~/crystal/backups] [--pending ~/crystal/judgments/pending]
      [--pending-max-age-hours 48] [--label com.jingshi.crystal-nightly]
      [--launchctl-print <file>]   # canned `launchctl print` output (tests)

Exit 0 whenever the checks ran (a failing check is a finding, not a crash); a
crash exits non-zero, so the captureCmd stops before the ops capture runs.
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import subprocess
import time
from pathlib import Path

RUN = re.compile(r"^── (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) nightly$")
DONE = re.compile(r"^── \d{2}:\d{2}:\d{2} done: nightly exit (\d+), verify exit (\d+)$")
CHAIN = re.compile(r"^chain: (ok|broken at row \d+)$")
REFOLD = re.compile(r"^refold: (identical|differs)$")
JUDGE = re.compile(r"^judge: answered (\d+), failed (\d+)$")
WAITING = re.compile(r"^judgments waiting for an answer: (\d+)$")
BACKUP = re.compile(r"^backup: .*?(log-\d{4}-\d{2}-\d{2}\.db)$")
LAUNCHD = {k: re.compile(rf"^\s*{k} = (.+)$", re.MULTILINE) for k in ("last exit code", "runs", "state")}


def latest_run(log: Path) -> tuple[datetime.datetime | None, list[str]]:
    """The start time (local) and the lines of the log's last run, or (None, []) when it has none."""
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    for i in range(len(lines) - 1, -1, -1):
        m = RUN.match(lines[i])
        if m:
            start = datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").astimezone()
            return start, lines[i + 1:]
    return None, []


def first(rx: re.Pattern, lines: list[str]) -> re.Match | None:
    return next((m for m in map(rx.match, lines) if m), None)


def check_fresh_run(log: Path, start, run: list[str], max_age_h: float, now) -> list[str]:
    out = [f"- log: {log}"]
    if not log.is_file():
        return out + [f"- error: no log at {log}: the LaunchAgent never ran, or its log moved"]
    if start is None:
        return out + ["- error: no `── <date> <time> nightly` line in the log: no run recorded"]
    errors = []
    age_h = (now - start).total_seconds() / 3600
    out.append(f"- run: {start:%Y-%m-%d %H:%M:%S} ({age_h:.1f}h ago, max {max_age_h:g}h)")
    if age_h > max_age_h:
        errors.append(f"latest run started {age_h:.0f}h ago (max {max_age_h:g}h): a night was missed")
    last = next((ln for ln in reversed(run) if ln.strip()), "")
    done = DONE.match(last)
    if not done:
        errors.append("the latest run's last line isn't `done: …`: it's still running, or it was killed mid-run")
    else:
        n, v = int(done.group(1)), int(done.group(2))
        out.append(f"- done: nightly exit {n}, verify exit {v}")
        if n or v:
            errors.append(f"done: nightly exit {n}, verify exit {v}")
    for name, rx, want in (("chain", CHAIN, "ok"), ("refold", REFOLD, "identical")):
        m = first(rx, run)
        out.append(f"- {name}: {m.group(1) if m else 'missing'}")
        if not m:
            errors.append(f"no `{name}:` line in the latest run (verify didn't finish)")
        elif m.group(1) != want:
            errors.append(f"{name}: {m.group(1)}")
    if errors:
        out.append("- error: " + "; ".join(errors))
    return out


def check_launchd(label: str, canned: Path | None) -> list[str]:
    target = f"gui/{os.getuid()}/{label}"
    if canned is not None:
        text, code = canned.read_text(encoding="utf-8"), 0
    else:
        p = subprocess.run(["launchctl", "print", target], capture_output=True, text=True, timeout=15)
        text, code = p.stdout, p.returncode
    out = [f"- job: {target}"]
    if code != 0:
        return out + [f"- error: not loaded (launchctl print exited {code}): rerun crystal-core's scripts/install-nightly.sh"]
    got = {k: (m.group(1).strip()[:40] if m else None) for k, rx in LAUNCHD.items() for m in [rx.search(text)]}
    out.append(f"- state: {got['state']} · runs: {got['runs']} · last exit code: {got['last exit code']}")
    if got["last exit code"] != "0":
        out.append(f"- error: launchd's last exit code = {got['last exit code']} (want 0)")
    return out


def check_backup(backups: Path, run: list[str], has_run: bool, today: datetime.date) -> list[str]:
    days = [today, today - datetime.timedelta(days=1)]
    names = [f"log-{d.isoformat()}.db" for d in days]
    found = [n for n in names if (backups / n).is_file() and (backups / n).stat().st_size > 0]
    out = [f"- folder: {backups}", f"- found: {', '.join(found) or 'none'} (want one of {', '.join(names)})"]
    errors = [] if found else [f"no {names[0]} or {names[1]} in {backups}: the nightly backup didn't run"]
    if has_run:
        m = first(BACKUP, run)
        out.append(f"- latest run backed up: {m.group(1) if m else 'nothing'}")
        if not m:
            errors.append("the latest run printed no `backup:` line (backups off in config.toml, or it died first)")
    if errors:
        out.append("- error: " + "; ".join(errors))
    return out


def check_judge(run: list[str], has_run: bool) -> list[str]:
    if not has_run:
        return ["- no run to read (fresh-run reports it)"]
    waiting = first(WAITING, run)
    out = [f"- waiting after the run: {waiting.group(1) if waiting else 'not printed'}"]
    judged = [m for m in map(JUDGE.match, run) if m]
    if not judged:
        return out + ["- judge: didn't run (nothing was waiting)"]
    answered, failed = sum(int(m.group(1)) for m in judged), sum(int(m.group(2)) for m in judged)
    out.append(f"- judge: answered {answered}, failed {failed}")
    if failed:
        out.append(f"- error: judge: answered {answered}, failed {failed} (an expired `claude` login? a timeout?)")
    return out


def check_pending(pending: Path, max_age_h: float, now_ts: float) -> list[str]:
    out = [f"- folder: {pending}"]
    if not pending.is_dir():
        return out + ["- pending: 0 (no folder yet: nothing has been asked)"]
    ages = sorted(((now_ts - p.stat().st_mtime) / 3600 for p in pending.glob("*.md") if p.is_file()), reverse=True)
    stale = [a for a in ages if a > max_age_h]
    out.append(f"- pending: {len(ages)}" + (f", oldest {ages[0]:.0f}h" if ages else ""))
    if stale:
        out.append(f"- error: {len(stale)} of {len(ages)} pending judgments older than {max_age_h:g}h"
                   f" (oldest {stale[0]:.0f}h): nobody is answering them — check the judge worker")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--log", default="~/Library/Logs/crystal/nightly.log")
    ap.add_argument("--max-age-hours", type=float, default=26)
    ap.add_argument("--backups", default="~/crystal/backups")
    ap.add_argument("--pending", default="~/crystal/judgments/pending")
    ap.add_argument("--pending-max-age-hours", type=float, default=48)
    ap.add_argument("--label", default="com.jingshi.crystal-nightly")
    ap.add_argument("--launchctl-print", default=None)
    a = ap.parse_args()

    log = Path(a.log).expanduser()
    now = datetime.datetime.now().astimezone()
    start, run = latest_run(log) if log.is_file() else (None, [])
    sections = {
        "fresh-run": check_fresh_run(log, start, run, a.max_age_hours, now),
        "launchd": check_launchd(a.label, Path(a.launchctl_print).expanduser() if a.launchctl_print else None),
        "backup": check_backup(Path(a.backups).expanduser(), run, start is not None, now.date()),
        "judge": check_judge(run, start is not None),
        "pending": check_pending(Path(a.pending).expanduser(), a.pending_max_age_hours, time.time()),
    }

    text = [f"# crystal-nightly — derived step log, {now.isoformat(timespec='seconds')}",
            "Written by health-sweep/bin/crystal-nightly-status.py: times, exit codes, counts and file names only.", ""]
    for name, lines in sections.items():
        text += [f"## {name}", *lines, ""]
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.tmp")
    tmp.write_text("\n".join(text), encoding="utf-8")
    os.replace(tmp, out)
    errors = [n for n, lines in sections.items() if any(ln.startswith("- error:") for ln in lines)]
    print(f"crystal-nightly: {len(sections) - len(errors)}/{len(sections)} checks clean"
          + (f" (failing: {', '.join(errors)})" if errors else "") + f" → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
