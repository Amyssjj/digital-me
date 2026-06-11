import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AGENT_COLORS,
  AGENT_FALLBACK,
  CHART_MARGIN,
  GRID_STROKE,
  TooltipShell,
  formatDateShort,
  legendProps,
  xAxisProps,
  yAxisProps,
} from "./chart-style";

type Tree = "wiki" | "tastes";

type DailyRow = {
  date: string;
  tree: Tree;
  surfaced_unique: number;
  acted_unique: number;
  rate: number | null;
};

type Result = {
  daily: DailyRow[];
  by_domain: (DailyRow & { domain: string })[];
  by_agent: (DailyRow & { agent_id: string })[];
};

/**
 * Metric #3: per-agent application rate over time.
 *
 * Four lines, one per detected agent (openclaw / claude-code / hermes /
 * codex). Each agent's daily rate rolls up across the two trees
 * (wiki + tastes) — Σacted / Σsurfaced for that (agent, date) — so the
 * line reflects "how often did this agent act on knowledge it surfaced
 * today" regardless of which tree the knowledge came from.
 *
 * Removed in this revision: the wiki-vs-tastes dual-axis split + the
 * per-domain tooltip breakdown. Per-agent is the question that matters
 * for evaluating which runtimes are actually applying surfaced
 * knowledge; the wiki/tastes split and per-domain rollup are left in
 * the underlying API for the Metrics definition panel + future drill-ins.
 */
export function ApplicationRateChart({ data }: { data: Result | null }) {
  if (!data || data.by_agent.length === 0) {
    return <EmptyChart />;
  }

  // Per-date, per-agent rollup across both trees.
  type Slot = { surfaced: number; acted: number };
  const byDateAgent = new Map<string, Map<string, Slot>>();
  const agentSet = new Set<string>();
  for (const r of data.by_agent) {
    agentSet.add(r.agent_id);
    const agentMap = byDateAgent.get(r.date) ?? new Map<string, Slot>();
    const slot = agentMap.get(r.agent_id) ?? { surfaced: 0, acted: 0 };
    slot.surfaced += r.surfaced_unique;
    slot.acted += r.acted_unique;
    agentMap.set(r.agent_id, slot);
    byDateAgent.set(r.date, agentMap);
  }
  const agents = [...agentSet].sort();

  // Flatten into a recharts-friendly series. Each row carries dateLabel
  // + one numeric field per agent.
  const series = [...byDateAgent.entries()]
    .map(([date, agentMap]) => {
      const row: Record<string, string | number | null> = {
        date,
        dateLabel: formatDateShort(date),
      };
      for (const agent of agents) {
        const slot = agentMap.get(agent);
        row[agent] =
          slot && slot.surfaced > 0 ? slot.acted / slot.surfaced : null;
      }
      return row;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={200}>
      <LineChart data={series} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="dateLabel" {...xAxisProps} />
        <YAxis
          {...yAxisProps}
          domain={[0, 1]}
          tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          tick={{ fontSize: 10, fill: "#9CA3AF" }}
        />
        <Tooltip
          wrapperStyle={{ zIndex: 50 }}
          content={(props) => {
            // Recharts types the tooltip payload as readonly; coerce
            // through `unknown` to the shape AgentRateTooltip consumes.
            const p = props as unknown as {
              active?: boolean;
              label?: string;
              payload?: Array<{
                dataKey?: string;
                value?: number | null;
                color?: string;
              }>;
            };
            if (!p.active || !p.label || !p.payload) return null;
            return <AgentRateTooltip label={p.label} payload={p.payload} />;
          }}
        />
        <Legend {...legendProps} />
        {agents.map((agent) => (
          <Line
            key={agent}
            type="monotone"
            dataKey={agent}
            name={agent}
            stroke={AGENT_COLORS[agent] ?? AGENT_FALLBACK}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function AgentRateTooltip({
  label,
  payload,
}: {
  label: string;
  payload: Array<{ dataKey?: string; value?: number | null; color?: string }>;
}) {
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined);
  return (
    <TooltipShell label={label}>
      {rows.length === 0 ? (
        <div style={{ color: "#9CA3AF", fontSize: "10px" }}>no data</div>
      ) : (
        rows.map((p) => (
          <div
            key={p.dataKey}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "1px 0",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "2px",
                  background: p.color,
                  display: "inline-block",
                }}
              />
              <span style={{ color: "#6B7280", fontSize: "10px" }}>
                {p.dataKey}
              </span>
            </span>
            <span style={{ fontWeight: 500, color: "#374151", fontSize: "10px" }}>
              {p.value === null || p.value === undefined
                ? "—"
                : `${Math.round((p.value as number) * 100)}%`}
            </span>
          </div>
        ))
      )}
    </TooltipShell>
  );
}

function EmptyChart() {
  return (
    <div className="h-48 flex items-center justify-center text-xs text-gray-400">
      no application_rate data yet — new sessions will populate this chart
    </div>
  );
}
