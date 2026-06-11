import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import { useDateRange } from "../hooks/DateRangeContext";
import {
  AGENT_COLORS,
  AGENT_FALLBACK,
} from "./metric-charts/chart-style";

/**
 * NUX scope-down §C follow-up: left-card snapshot for the "Daily activity"
 * row. Replaces the PlaceholderCard with a sorted per-agent totals view:
 *
 *   Total Sessions: 142
 *   ───────────────────
 *   claude-code  ████████████████  80   56%
 *   openclaw     ████              20   14%
 *   codex        █                  5    4%
 *   hermes       █                  5    4%
 *
 * The bars are pure CSS (width-percentage divs) — no Recharts dependency
 * needed for such a small visualization. Bar fills use the same AGENT_COLORS
 * palette as the right-side chart so the two views read as one surface.
 */

interface Row {
  date: string;
  agent_id: string;
  sessions: number;
  is_active: 0 | 1;
}

interface SessionsResponse {
  rows: Row[];
  agents: string[];
}

interface AgentTotal {
  agent_id: string;
  sessions: number;
  pct: number;
  color: string;
}

export function SessionsLeftCard({ index }: { readonly index: number }) {
  const { days } = useDateRange();
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/metrics/sessions-by-agent?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SessionsResponse>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const { total, agentTotals } = useMemo<{
    total: number;
    agentTotals: AgentTotal[];
  }>(() => {
    if (!data) return { total: 0, agentTotals: [] };
    // Sum sessions per agent across the window.
    const sums = new Map<string, number>();
    for (const r of data.rows) {
      sums.set(r.agent_id, (sums.get(r.agent_id) ?? 0) + r.sessions);
    }
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    const agentTotals: AgentTotal[] = [...sums.entries()]
      .map(([agent_id, sessions]) => ({
        agent_id,
        sessions,
        pct: total > 0 ? (sessions / total) * 100 : 0,
        color: AGENT_COLORS[agent_id] ?? AGENT_FALLBACK,
      }))
      .sort((a, b) => b.sessions - a.sessions);
    return { total, agentTotals };
  }, [data]);

  // Max sessions value used to scale the horizontal bars. Falls back to 1
  // to avoid division by zero on an empty window.
  const maxValue = agentTotals[0]?.sessions ?? 1;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.05 * index }}
      className="glass-card h-full min-h-[260px] p-5 flex flex-col"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-gray-500">Total Sessions</span>
        <span className="text-2xl font-semibold text-gray-800 tabular-nums">
          {loading ? "…" : error ? "—" : total.toLocaleString()}
        </span>
      </div>

      <div className="my-3 border-t border-gray-100" />

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-gray-400">
          loading…
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-red-500 font-mono">
          {error}
        </div>
      ) : agentTotals.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-gray-400">
          no sessions in this window
        </div>
      ) : (
        <ul className="space-y-2">
          {agentTotals.map((a) => (
            <AgentRow key={a.agent_id} agent={a} maxValue={maxValue} />
          ))}
        </ul>
      )}
    </motion.div>
  );
}

function AgentRow({ agent, maxValue }: { agent: AgentTotal; maxValue: number }) {
  const widthPct = maxValue > 0 ? (agent.sessions / maxValue) * 100 : 0;
  return (
    <li className="grid grid-cols-[80px_1fr_auto_auto] items-center gap-2 text-[11px]">
      <span className="text-gray-600 truncate" title={agent.agent_id}>
        {agent.agent_id}
      </span>
      <div className="relative h-2 rounded-sm bg-gray-100 overflow-hidden">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-sm"
          initial={{ width: 0 }}
          animate={{ width: `${widthPct}%` }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          style={{ background: agent.color, opacity: 0.85 }}
        />
      </div>
      <span className="font-mono text-gray-700 tabular-nums text-right" style={{ minWidth: "2.5em" }}>
        {agent.sessions.toLocaleString()}
      </span>
      <span className="font-mono text-gray-400 tabular-nums text-right" style={{ minWidth: "3em" }}>
        {agent.pct.toFixed(0)}%
      </span>
    </li>
  );
}
