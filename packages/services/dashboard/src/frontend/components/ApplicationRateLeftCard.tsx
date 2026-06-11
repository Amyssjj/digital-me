import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import { useDateRange } from "../hooks/DateRangeContext";
import {
  AGENT_COLORS,
  AGENT_FALLBACK,
} from "./metric-charts/chart-style";

/**
 * Left card for the "Application rate (M1)" row.
 *
 *   Overall application rate:           Z%
 *   ─────────────────────────────────────
 *   openclaw     ██████████████  82%
 *   claude-code  ████████        47%
 *   hermes       ███              19%
 *   codex        ▌                 3%
 *
 * "Overall" rolls up Σacted / Σsurfaced across every (date, tree, agent)
 * row in the window. Per-agent rates use that agent's own sums across
 * trees + dates, then sorted descending by rate. Bar fill width is
 * proportional to the leading agent's rate so the visual scale matches
 * the SessionsLeftCard pattern.
 */

type Tree = "wiki" | "tastes";

type DailyRow = {
  date: string;
  tree: Tree;
  surfaced_unique: number;
  acted_unique: number;
  rate: number | null;
};

type ByAgentRow = DailyRow & { agent_id: string };

type Result = {
  daily: DailyRow[];
  by_domain: (DailyRow & { domain: string })[];
  by_agent: ByAgentRow[];
};

interface AgentRate {
  agent_id: string;
  surfaced: number;
  acted: number;
  rate: number;
  color: string;
}

export function ApplicationRateLeftCard({ index }: { readonly index: number }) {
  const { days } = useDateRange();
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/metrics/application-rate?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Result>;
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

  const { overall, agents } = useMemo<{
    overall: number;
    agents: AgentRate[];
  }>(() => {
    if (!data) return { overall: 0, agents: [] };
    // Per-agent rollup across all (date, tree) rows for that agent.
    const sums = new Map<string, { surfaced: number; acted: number }>();
    let totalSurfaced = 0;
    let totalActed = 0;
    for (const r of data.by_agent) {
      const slot = sums.get(r.agent_id) ?? { surfaced: 0, acted: 0 };
      slot.surfaced += r.surfaced_unique;
      slot.acted += r.acted_unique;
      sums.set(r.agent_id, slot);
      totalSurfaced += r.surfaced_unique;
      totalActed += r.acted_unique;
    }
    const overall = totalSurfaced > 0 ? totalActed / totalSurfaced : 0;
    const agents: AgentRate[] = [...sums.entries()]
      .map(([agent_id, { surfaced, acted }]) => ({
        agent_id,
        surfaced,
        acted,
        rate: surfaced > 0 ? acted / surfaced : 0,
        color: AGENT_COLORS[agent_id] ?? AGENT_FALLBACK,
      }))
      .filter((a) => a.surfaced > 0)
      .sort((a, b) => b.rate - a.rate);
    return { overall, agents };
  }, [data]);

  // Scale the horizontal bars against the leading agent's rate so the
  // visual matches the SessionsLeftCard pattern (leader fills the bar).
  const maxRate = agents[0]?.rate ?? 1;

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.05 * index }}
      className="glass-card h-full min-h-[260px] p-5 flex flex-col"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-gray-500">Overall application rate</span>
        <span className="text-2xl font-semibold text-gray-800 tabular-nums">
          {loading ? "…" : error ? "—" : `${Math.round(overall * 100)}%`}
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
      ) : agents.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-gray-400">
          no application_rate data in this window
        </div>
      ) : (
        <ul className="space-y-2">
          {agents.map((a) => (
            <AgentRateRow key={a.agent_id} agent={a} maxRate={maxRate} />
          ))}
        </ul>
      )}
    </motion.div>
  );
}

function AgentRateRow({
  agent,
  maxRate,
}: {
  agent: AgentRate;
  maxRate: number;
}) {
  const widthPct = maxRate > 0 ? (agent.rate / maxRate) * 100 : 0;
  return (
    <li className="grid grid-cols-[80px_1fr_auto] items-center gap-2 text-[11px]">
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
      <span
        className="font-mono text-gray-700 tabular-nums text-right"
        style={{ minWidth: "3em" }}
      >
        {`${Math.round(agent.rate * 100)}%`}
      </span>
    </li>
  );
}
