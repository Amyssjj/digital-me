#!/usr/bin/env python3
"""health-sweep ops helper — Crystal Core's nightly, read back as a step log.

`crystal nightly` runs as the LaunchAgent com.jingshi.crystal-nightly (daily
04:15, crystal-core scripts/nightly.sh: nightly, then verify) and appends to
~/Library/Logs/crystal/nightly.log. Nothing else reads that log or launchd's
exit code, so a failed night, a judge whose `claude` login expired, or a missing
backup would pass silently. This reads them and writes a derived step log the
ops capture scans like any other: one `## <check>` section per check. A failing
check writes `- error: …` (profiles/ops.json stepLog `crystal-nightly`, an O2
block, overridable as `crystal-nightly#<check>`); a check that only warns writes
`- warn: …` (stepLog `crystal-nightly-warn`, required:false, so O2 advisory).

  fresh-run  error: the log's latest run started within --max-age-hours, its
             last line reads `done: nightly exit 0, verify exit 0`, and it
             printed `chain: ok` and `refold: identical`
  launchd    error: `launchctl print gui/<uid>/<label>` says `last exit code = 0`
  backup     error: <backups>/log-<today or yesterday>.db exists, and the latest
             run printed a `backup:` line
  judge      warn: no `judge: answered N, failed M` line with M > 0 in the
             latest run
  waiting    warn: `judgments waiting for an answer: N` was above 0 at the end
             of the last run of each of the last --waiting-nights nights

Read-only: it reads the log, the names and sizes in the backups folder, and
`launchctl print`; its only write is --out. The log quotes Jing's words, so only
fixed status lines are matched and only times, exit codes, counts and file names
go out, never a line's free text. Stdlib-only, Python 3.9+ (`bash -lc` resolves
python3 to /usr/bin/python3).

  crystal-nightly-status.py --out health-sweep/capture-crystal-nightly.md
      [--log ~/Library/Logs/crystal/nightly.log] [--max-age-hours 30]
      [--backups ~/crystal/backups] [--waiting-nights 3]
      [--label com.jingshi.crystal-nightly]
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
from pathlib import Path

RUN = re.compile(r"^── (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) nightly$")
DONE = re.compile(r"^── \d{2}:\d{2}:\d{2} done: nightly exit (\d+), verify exit (\d+)$")
CHAIN = re.compile(r"^chain: (ok|broken at row \d+)$")
REFOLD = re.compile(r"^refold: (identical|differs)$")
JUDGE = re.compile(r"^judge: answered (\d+), failed (\d+)$")
WAITING = re.compile(r"^judgments waiting for an answer: (\d+)$")
BACKUP = re.compile(r"^backup: .*?(log-\d{4}-\d{2}-\d{2}\.db)$")
LAUNCHD = {k: re.compile(rf"^\s*{k} = (.+)$", re.MULTILINE) for k in ("last exit code", "runs", "state")}


def runs(log: Path) -> list[tuple[datetime.datetime, list[str]]]:
    """Every run in the log, oldest first: its start time (local) and its lines up to the next run."""
    out: list[tuple[datetime.datetime, list[str]]] = []
    for ln in log.read_text(encoding="utf-8", errors="replace").splitlines():
        m = RUN.match(ln)
        if m:
            out.append((datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").astimezone(), []))
        elif out:
            out[-1][1].append(ln)
    return out


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
    judged = [m for m in map(JUDGE.match, run) if m]
    if not judged:
        return ["- judge: didn't run in the latest run (nothing was waiting, or no `judge` model in config.toml)"]
    answered, failed = sum(int(m.group(1)) for m in judged), sum(int(m.group(2)) for m in judged)
    out = [f"- judge: answered {answered}, failed {failed}"]
    if failed:
        out.append(f"- warn: judge: answered {answered}, failed {failed} (an expired `claude` login? a timeout?)")
    return out


def check_waiting(all_runs: list[tuple[datetime.datetime, list[str]]], nights: int) -> list[str]:
    if not all_runs:
        return ["- no run to read (fresh-run reports it)"]
    by_day: dict[datetime.date, int | None] = {}
    for start, lines in all_runs:                       # oldest first, so each day keeps its last run's count
        m = first(WAITING, lines)
        by_day[start.date()] = int(m.group(1)) if m else None
    days = sorted(by_day, reverse=True)
    streak = next((i for i, d in enumerate(days) if not by_day[d]), len(days))
    latest = by_day[days[0]]
    out = [f"- waiting after the latest run: {'not printed' if latest is None else latest}",
           f"- nights in a row ending with judgments waiting: {streak} (warn at {nights})"]
    if streak >= nights:
        out.append(f"- warn: judgments left waiting for an answer {streak} nights in a row (latest {latest}):"
                   " the judge isn't clearing them — check its `claude` login, or answer judgments/pending by hand")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--log", default="~/Library/Logs/crystal/nightly.log")
    ap.add_argument("--max-age-hours", type=float, default=30)
    ap.add_argument("--backups", default="~/crystal/backups")
    ap.add_argument("--waiting-nights", type=int, default=3)
    ap.add_argument("--label", default="com.jingshi.crystal-nightly")
    ap.add_argument("--launchctl-print", default=None)
    a = ap.parse_args()

    log = Path(a.log).expanduser()
    now = datetime.datetime.now().astimezone()
    all_runs = runs(log) if log.is_file() else []
    start, run = all_runs[-1] if all_runs else (None, [])
    sections = {
        "fresh-run": check_fresh_run(log, start, run, a.max_age_hours, now),
        "launchd": check_launchd(a.label, Path(a.launchctl_print).expanduser() if a.launchctl_print else None),
        "backup": check_backup(Path(a.backups).expanduser(), run, start is not None, now.date()),
        "judge": check_judge(run, start is not None),
        "waiting": check_waiting(all_runs, a.waiting_nights),
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
    flagged = {kind: [n for n, lines in sections.items() if any(ln.startswith(f"- {kind}:") for ln in lines)]
               for kind in ("error", "warn")}
    print(f"crystal-nightly: {len(sections) - len(flagged['error']) - len(flagged['warn'])}/{len(sections)} checks clean"
          + "".join(f" ({label}: {', '.join(flagged[kind])})"
                    for kind, label in (("error", "failing"), ("warn", "warning")) if flagged[kind])
          + f" → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
