#!/usr/bin/env python3
"""
analyze_brain_inject.py — Day-N analysis of the brain-injection PreToolUse experiment.

Reads ~/.claude/logs/brain_route_inject.jsonl and the Claude Code session JSONLs
in ~/.claude/projects/, correlates fire events with what the agent did next, and
emits a results markdown doc.

Run manually any time:  python3 ~/.claude/hooks/analyze_brain_inject.py
"""

import json
import os
import sys
import glob
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

LOG_PATH = os.path.expanduser('~/.claude/logs/brain_route_inject.jsonl')
PROJECTS_DIR = os.path.expanduser('~/.claude/projects')
EXPERIMENT_START = datetime(2026, 4, 30, 21, 50, tzinfo=timezone.utc)  # 14:50 PT = 21:50 UTC
TIMESTAMP_TOLERANCE_SEC = 10
LOOKAHEAD_TOOL_CALLS = 3


def parse_iso(s):
    if not s:
        return None
    s = s.replace('Z', '+00:00')
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def load_log():
    if not os.path.exists(LOG_PATH):
        return []
    out = []
    with open(LOG_PATH) as f:
        for line in f:
            try:
                e = json.loads(line)
                e['ts'] = parse_iso(e.get('t'))
                if e['ts'] and e['ts'] >= EXPERIMENT_START:
                    out.append(e)
            except Exception:
                pass
    return out


def load_sessions():
    """Return list of (path, [events]) for sessions modified since experiment start."""
    sessions = []
    for path in glob.glob(os.path.join(PROJECTS_DIR, '*', '*.jsonl')):
        mt = datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc)
        if mt < EXPERIMENT_START - timedelta(hours=1):
            continue
        events = []
        try:
            with open(path) as f:
                for line in f:
                    try:
                        events.append(json.loads(line))
                    except Exception:
                        pass
        except Exception:
            continue
        if events:
            sessions.append((path, events))
    return sessions


def extract_tool_uses(events):
    """From a session's events list, extract chronological tool_use entries with timestamp."""
    out = []
    for e in events:
        if e.get('type') != 'assistant':
            continue
        ts = parse_iso(e.get('timestamp') or e.get('t'))
        msg = e.get('message', {})
        for c in msg.get('content', []) or []:
            if isinstance(c, dict) and c.get('type') == 'tool_use':
                out.append({
                    'ts': ts,
                    'name': c.get('name', ''),
                    'input': c.get('input', {}),
                    'id': c.get('id'),
                })
    return out


def find_fire_in_sessions(fire, sessions):
    """Given a log fire event, find (session_path, tool_uses, idx) of the matching tool_use.
    Match by tool name + timestamp within tolerance.
    """
    target_name = fire['tool']
    target_ts = fire['ts']
    best = None
    best_delta = None
    for path, events in sessions:
        tus = extract_tool_uses(events)
        for i, tu in enumerate(tus):
            if tu['name'] != target_name or not tu['ts']:
                continue
            delta = abs((tu['ts'] - target_ts).total_seconds())
            if delta <= TIMESTAMP_TOLERANCE_SEC:
                if best_delta is None or delta < best_delta:
                    best = (path, tus, i)
                    best_delta = delta
    return best


def check_compliance(rule, tus, fire_idx):
    """Look at the next LOOKAHEAD_TOOL_CALLS tool uses after fire_idx and assess compliance.
    Returns: ('compliant'|'non-compliant'|'no-followup'|'spec-mismatch', detail_str)
    """
    after = tus[fire_idx + 1: fire_idx + 1 + LOOKAHEAD_TOOL_CALLS]
    if not after:
        return ('no-followup', 'no subsequent tool calls in session')

    if rule == 'brain-write-via-tasks':
        # R1a: did the agent switch to mcp__openclaw-brain__tasks?
        for tu in after:
            if tu['name'] == 'mcp__openclaw-brain__tasks':
                return ('compliant', f"next switched to tasks MCP ({tu['input'].get('action','?')})")
        # Did they keep using sqlite3 writes?
        for tu in after:
            if tu['name'] == 'Bash':
                cmd = tu['input'].get('command', '')
                if 'sqlite3' in cmd and any(k in cmd.upper() for k in ('INSERT', 'UPDATE', 'DELETE')):
                    return ('non-compliant', 'next call still raw sqlite3 write')
        return ('non-compliant', f"next was {after[0]['name']}, no tasks MCP switch")

    elif rule == 'tasks-json-format':
        # R2: only count followups for actions that actually return parsable output.
        # handoff/run_goal/checkpoint/etc. don't need format — skip those.
        parsable_actions = {'board', 'status', 'schedule_list', 'workflow_list'}
        for tu in after:
            if tu['name'] != 'mcp__openclaw-brain__tasks':
                continue
            action = tu['input'].get('action', '')
            if action not in parsable_actions:
                continue  # not a relevant followup, keep looking
            fmt = tu['input'].get('format')
            if fmt == 'json':
                return ('compliant', f'next {action} call included format:json')
            return ('non-compliant', f"next {action} call no format")
        return ('no-followup', 'no subsequent parsable-action tasks call')

    elif rule == 'stringify-tasks':
        # R3: did next tasks call pass tasks/variables as strings?
        for tu in after:
            if tu['name'] == 'mcp__openclaw-brain__tasks':
                inp = tu['input']
                tasks_v = inp.get('tasks')
                vars_v = inp.get('variables')
                bad = (isinstance(tasks_v, list)) or (isinstance(vars_v, dict))
                if bad:
                    return ('non-compliant', 'still passing native types')
                return ('compliant', 'tasks/variables are strings or absent')
        return ('no-followup', 'no subsequent tasks MCP call')

    return ('unknown-rule', rule)


def main():
    log = load_log()
    sessions = load_sessions()

    fires = [e for e in log if e.get('injected') == 'yes']
    skips = [e for e in log if e.get('injected') == 'no']

    rule_counts = Counter(e['rule'] for e in fires)
    skip_count_by_tool = Counter(e['tool'] for e in skips)

    # Per-rule compliance
    per_rule = defaultdict(lambda: {'fires': [], 'compliant': 0, 'non-compliant': 0, 'no-followup': 0, 'spec-mismatch': 0})

    for fire in fires:
        rule = fire['rule']
        match = find_fire_in_sessions(fire, sessions)
        if not match:
            per_rule[rule]['fires'].append({
                't': fire['t'], 'tool': fire['tool'],
                'session': None, 'compliance': 'no-session-match', 'detail': 'fire could not be matched to a session tool_use'
            })
            continue
        path, tus, idx = match
        outcome, detail = check_compliance(rule, tus, idx)
        per_rule[rule][outcome] += 1
        per_rule[rule]['fires'].append({
            't': fire['t'], 'tool': fire['tool'],
            'session': os.path.basename(path),
            'compliance': outcome, 'detail': detail
        })

    # Headline
    rules_passing = 0
    rules_with_volume = 0
    for rule, data in per_rule.items():
        n_compliant = data['compliant']
        n_non = data['non-compliant']
        decided = n_compliant + n_non
        if decided >= 3:
            rules_with_volume += 1
            rate = n_compliant / decided if decided else 0
            if rate >= 0.6:
                rules_passing += 1

    if rules_passing >= 2:
        outcome_label = 'PASS'
        recommendation = 'Build brain.before_tool MCP server-side. The closed loop is real.'
    elif rules_with_volume == 0:
        outcome_label = 'INSUFFICIENT VOLUME'
        recommendation = 'Triggers too narrow at the day-2 mark. Either widen rules or extend window. Consider adding rules for tools agents actually call (Bash sqlite3 SELECTs as a soft nudge, etc.)'
    elif rules_passing == 0:
        outcome_label = 'FAIL'
        recommendation = 'Hook fires but agent ignores injected text. Architectural bet may be wrong; investigate prompt-format issues before brain-side build.'
    else:
        outcome_label = 'PARTIAL'
        recommendation = 'One rule works; others need iteration. Likely entry-format issue — try adding short "operational snippet" sections to wiki entries and re-run.'

    # Build markdown report
    today = datetime.now().strftime('%Y-%m-%d')
    out_path = os.path.expanduser(f'~/.claude/plans/brain-injection-results-{today}.md')

    lines = [
        f'# Brain Injection Experiment — Day-{(datetime.now(tz=timezone.utc) - EXPERIMENT_START).days} Analysis ({today})',
        '',
        f'Experiment start: 2026-04-30 14:50 PT  |  This run: {datetime.now().isoformat(timespec="minutes")}',
        '',
        f'## Headline: {outcome_label}',
        '',
        f'**Recommendation**: {recommendation}',
        '',
        '## Volume',
        '',
        f'- Total log events: {len(log)}',
        f'- Fires: {sum(rule_counts.values())}  |  Skips: {len(skips)}',
        '',
        '### Fires by rule',
        '',
        '| Rule | Fires | Compliant | Non-compliant | No-followup | Compliance rate |',
        '|---|---|---|---|---|---|',
    ]
    for rule in ('brain-write-via-tasks', 'tasks-json-format', 'stringify-tasks'):
        d = per_rule.get(rule, {'fires': [], 'compliant': 0, 'non-compliant': 0, 'no-followup': 0})
        total_decided = d['compliant'] + d['non-compliant']
        rate = (d['compliant'] / total_decided * 100) if total_decided else None
        rate_str = f'{rate:.0f}%' if rate is not None else 'n/a'
        lines.append(f"| {rule} | {len(d['fires'])} | {d['compliant']} | {d['non-compliant']} | {d['no-followup']} | {rate_str} |")

    lines += [
        '',
        '## Skips by tool (top 10)',
        '',
        '| Tool | Skips |',
        '|---|---|',
    ]
    for tool, n in skip_count_by_tool.most_common(10):
        lines.append(f'| {tool or "(none)"} | {n} |')

    lines += [
        '',
        '## Findings',
        '',
        f'- {len(sessions)} session JSONLs covered the experiment window.',
        f'- {sum(1 for r in per_rule.values() for f in r["fires"] if f["compliance"] == "no-session-match")} fires could not be matched to a session tool_use (timestamp tolerance ±{TIMESTAMP_TOLERANCE_SEC}s).',
    ]

    # Per-rule observations
    for rule, data in per_rule.items():
        if not data['fires']:
            continue
        details = Counter(f['detail'] for f in data['fires'])
        common = details.most_common(3)
        lines.append(f'- **{rule}**: most common pattern — {common[0][0]} ({common[0][1]}x).' if common else '')

    lines += [
        '',
        '## Raw fire events',
        '',
        '| Time | Tool | Rule | Session | Compliance | Detail |',
        '|---|---|---|---|---|---|',
    ]
    for rule, data in per_rule.items():
        for f in data['fires']:
            lines.append(f"| {f['t']} | {f['tool']} | {rule} | {f.get('session','-')} | {f['compliance']} | {f.get('detail','')} |")

    lines.append('')

    with open(out_path, 'w') as f:
        f.write('\n'.join(lines))

    # Also write a 5-line summary
    summary_path = os.path.expanduser(f'~/.claude/plans/brain-injection-results-{today}-SUMMARY.txt')
    with open(summary_path, 'w') as f:
        f.write(f'Brain Injection Experiment — Day-{(datetime.now(tz=timezone.utc) - EXPERIMENT_START).days} ({today})\n')
        f.write(f'Outcome: {outcome_label}\n')
        for rule in ('brain-write-via-tasks', 'tasks-json-format', 'stringify-tasks'):
            d = per_rule.get(rule, {'compliant': 0, 'non-compliant': 0, 'fires': []})
            decided = d['compliant'] + d['non-compliant']
            rate = (d['compliant'] / decided * 100) if decided else 0
            f.write(f'  {rule}: {len(d["fires"])} fires, {rate:.0f}% compliance\n')
        f.write(f'Next: {recommendation}\n')

    # Stdout summary for human / scheduled-task console
    print(f'OUTCOME: {outcome_label}')
    for rule in ('brain-write-via-tasks', 'tasks-json-format', 'stringify-tasks'):
        d = per_rule.get(rule, {'compliant': 0, 'non-compliant': 0, 'fires': []})
        decided = d['compliant'] + d['non-compliant']
        rate = (d['compliant'] / decided * 100) if decided else 0
        print(f'  {rule}: {len(d["fires"])} fires, {rate:.0f}% compliance')
    print(f'Wrote: {out_path}')
    print(f'Wrote: {summary_path}')


if __name__ == '__main__':
    main()
