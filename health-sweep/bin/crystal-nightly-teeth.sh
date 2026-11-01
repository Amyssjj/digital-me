#!/usr/bin/env bash
# health-sweep · bin/crystal-nightly-teeth.sh — prove the crystal-nightly ops checks have teeth.
#
# Each case plants one fault in a green nightly log (or in its backups or launchd output), runs
# the real chain in a temp repo (bin/crystal-nightly-status.py → the ops capture → the ops gates,
# with this checkout's profiles/ops.json) and checks that exactly the planted crystal finding
# fires, at the planted severity (an advisory one reads `adv:<sel>`), and on the green case none.
# Hermetic by default: a synthetic three-night log in nightly.sh's shape. --seed <nightly.log>
# doctors a copy of a real log instead (the copy stays in the temp dir, removed on exit). Never
# touches ~/crystal or the real log.
#
#   bash health-sweep/bin/crystal-nightly-teeth.sh [--seed ~/Library/Logs/crystal/nightly.log]
#   PYTHON=/usr/bin/python3 bash health-sweep/bin/crystal-nightly-teeth.sh   # the python `bash -lc` finds
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
engine="$HOME/.agents/skills/motus-ops-sweep/engine"
py=${PYTHON:-python3}
seed=""; [ "${1:-}" = "--seed" ] && seed=$2
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

night() {  # night <date> <time>
  printf '── %s %s nightly\nobserved: obsidian 0\njudgments waiting for an answer: 0\nbackup: /x/log-%s.db\nledger: committed\n── %s verify\nchain: ok\nrefold: identical\n── %s done: nightly exit 0, verify exit 0\n\n' \
    "$1" "$2" "$1" "$2" "$2"
}
green_log() {
  if [ -n "$seed" ]; then cat "$seed"; return; fi
  night "$(date -v-2d +%F)" 04:15:03; night "$(date -v-1d +%F)" 04:15:04; night "$(date +%F)" "$(date +%H:%M:%S)"
}
# retime <age>: the latest run started <age> ago (date -v form: 28H, 2d)
retime() {
  awk -v ts="$(date -v-"$1" '+%Y-%m-%d %H:%M:%S')" '{ l[NR] = $0 } /^── [0-9-]+ [0-9:]+ nightly$/ { last = NR }
    END { for (i = 1; i <= NR; i++) print (i == last ? "── " ts " nightly" : l[i]) }'
}
# waiting_last <k>: every run on the log's last <k> nights ends with 2 judgments waiting
waiting_last() {
  awk -v k="$1" '{ l[NR] = $0 } /^── [0-9-]+ [0-9:]+ nightly$/ { r[++n] = NR; d[n] = $2 }
    END { from = NR + 1; nights = 0; prev = ""
      for (j = n; j >= 1; j--) { if (d[j] != prev) { nights++; prev = d[j] } if (nights > k) break; from = r[j] }
      for (i = 1; i <= NR; i++) { if (i >= from) sub(/waiting for an answer: [0-9]+$/, "waiting for an answer: 2", l[i]); print l[i] } }'
}
launchd_out() { printf 'gui/%s/com.jingshi.crystal-nightly = {\n\tstate = not running\n\truns = 1\n\tlast exit code = %s\n}\n' "$(id -u)" "$1"; }

pass=0; fail=0
# case <name> <expected crystal sels, space-separated, "" = none> — reads the fault vars set before it
case_() {
  name=$1 want=$2 r="$tmp/$1"
  mkdir -p "$r/health-sweep" "$r/backups"
  cp -R "$here/profiles" "$r/health-sweep/"; echo '[]' > "$r/health-sweep/overrides.json"
  green_log | eval "${doctor:-cat}" > "$r/nightly.log"
  [ -n "${backup_file-x}" ] && echo db > "$r/backups/log-$(date +%F).db"
  launchd_out "${exit_code:-0}" > "$r/launchd.txt"
  log="$r/nightly.log"; [ -n "${no_log:-}" ] && log="$r/absent.log"
  lc=(--launchctl-print "$r/launchd.txt"); [ -n "${absent_label:-}" ] && lc=(--label com.jingshi.crystal-nightly-teeth-absent)
  out="$r/health-sweep/capture-crystal-nightly.md"
  if [ -z "${skip_helper:-}" ]; then
    "$py" "$here/bin/crystal-nightly-status.py" --out "$out" --log "$log" --backups "$r/backups" \
      "${lc[@]}" > /dev/null || { echo "FAIL $name: helper crashed"; fail=$((fail + 1)); return; }
  fi
  [ -n "${out_age:-}" ] && touch -t "$(date -v-"$out_age" +%Y%m%d%H%M)" "$out"
  (cd "$r" && node "$engine/lib/capture-ops.mjs" --repo . --profile health-sweep/profiles/ops.json \
    --out health-sweep/capture-ops.json > /dev/null && node "$engine/runner.mjs" --project health-sweep --profile ops > /dev/null)
  [ -f "$r/health-sweep/scorecard-ops.json" ] || { echo "FAIL $name: the ops gates wrote no scorecard"; fail=$((fail + 1)); return; }
  got=$(node -e 'const s = require(process.argv[1]);
    console.log([...s.findings.map((f) => f.sel), ...(s.advisory || []).map((f) => `adv:${f.sel}`)]
    .filter((sel) => sel.replace(/^adv:/, "").startsWith("crystal-nightly")).sort().join(" "))' "$r/health-sweep/scorecard-ops.json")
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); echo "ok   $name → ${got:-clean}"
  else fail=$((fail + 1)); echo "FAIL $name: got '${got:-clean}', want '${want:-clean}'"; fi
}

old=$(date -v-2d +%F)
doctor= case_ green ""
doctor="sed 's/nightly exit 0, verify exit 0/nightly exit 1, verify exit 0/'" case_ nightly-exit crystal-nightly#fresh-run
doctor="sed -e 's/verify exit 0/verify exit 1/' -e 's/^chain: ok\$/chain: broken at row 7/'" case_ verify-broken crystal-nightly#fresh-run
doctor="sed -E 's/^(── )[0-9]{4}-[0-9]{2}-[0-9]{2}/\\1$old/'" case_ stale-run crystal-nightly#fresh-run
doctor="retime 28H" case_ late-wake ""     # the Mac slept through 03:30 and 04:15: the sweep reads yesterday's run
doctor="retime 31H" case_ missed-night crystal-nightly#fresh-run
doctor="sed '/ done: nightly exit/d'" case_ killed-mid-run crystal-nightly#fresh-run
no_log=1 case_ no-log crystal-nightly#fresh-run
doctor="awk '/^judgments waiting for an answer:/{print \"judge: answered 0, failed 2\"} 1'" case_ judge-failed adv:crystal-nightly-warn#judge
doctor="awk '/^judgments waiting for an answer:/{print \"judge: answered 3, failed 0\"} 1'" case_ judge-ok ""
doctor="waiting_last 3" case_ waiting-3-nights adv:crystal-nightly-warn#waiting
doctor="waiting_last 2" case_ waiting-2-nights ""
backup_file= case_ no-backup-file crystal-nightly#backup
doctor="sed '/^backup: /d'" case_ no-backup-line crystal-nightly#backup
exit_code=1 case_ launchd-exit crystal-nightly#launchd
absent_label=1 case_ launchd-not-loaded crystal-nightly#launchd
skip_helper=1 case_ derived-log-missing crystal-nightly-check
out_age=26H case_ derived-log-stale crystal-nightly-check     # what a capture that skipped the helper leaves: yesterday's

echo "crystal-nightly teeth: $pass passed, $fail failed${seed:+ (seed: $seed)}"
[ "$fail" -eq 0 ]
