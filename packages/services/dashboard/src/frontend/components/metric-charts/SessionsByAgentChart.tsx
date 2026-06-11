import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
  HIGHLIGHT,
  TooltipDivider,
  TooltipHeader,
  TooltipRow,
  TooltipShell,
  Y_LABEL_STYLE,
  formatDateShort,
  legendProps,
  xAxisProps,
  yAxisProps,
} from "./chart-style";

type Row = {
  date: string;
  agent_id: string;
  sessions: number;
  is_active: 0 | 1;
};

type Result = {
  rows: Row[];
  agents: string[];
};

/**
 * Metric #1: sessions × active agents.
 *
 * Per the dual-axis-time-series-chart-pattern wiki rule + user feedback:
 *   - Left axis = total sessions: stacked bars by agent_id sum to the
 *     day's total. The stack tops ARE the total sessions line, so no
 *     redundant line is drawn on the left.
 *   - Right axis = total active agents: separate small-integer scale
 *     (0..max+1) so the agent-count line isn't crushed by the sessions
 *     scale.
 */
export function SessionsByAgentChart({ data }: { data: Result | null }) {
  if (!data || data.rows.length === 0) {
    return <EmptyChart />;
  }

  const byDate = new Map<
    string,
    Record<string, number> & {
      date: string;
      dateLabel: string;
      __total_sessions: number;
      __active_agents: number;
    }
  >();
  for (const r of data.rows) {
    const slot =
      byDate.get(r.date) ??
      ({
        date: r.date,
        dateLabel: formatDateShort(r.date),
        __total_sessions: 0,
        __active_agents: 0,
      } as ReturnType<typeof byDate.get> & object);
    slot[r.agent_id] = r.sessions;
    slot.__total_sessions += r.sessions;
    slot.__active_agents += r.is_active;
    byDate.set(r.date, slot);
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={200}>
      <ComposedChart data={series} margin={CHART_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
        <XAxis dataKey="dateLabel" {...xAxisProps} />
        <YAxis
          yAxisId="left"
          {...yAxisProps}
          label={{ value: "total sessions", angle: -90, position: "insideLeft", style: Y_LABEL_STYLE }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          {...yAxisProps}
          tick={{ fontSize: 10, fill: HIGHLIGHT }}
          domain={[0, (dataMax: number) => Math.max(1, dataMax + 1)]}
          allowDecimals={false}
          label={{ value: "active agents", angle: 90, position: "insideRight", style: { ...Y_LABEL_STYLE, fill: HIGHLIGHT } }}
        />
        <Tooltip content={<SessionsTooltip />} wrapperStyle={{ zIndex: 50 }} />
        <Legend {...legendProps} />
        {data.agents.map((agent) => (
          <Bar
            key={agent}
            yAxisId="left"
            dataKey={agent}
            stackId="sessions"
            name={agent}
            fill={AGENT_COLORS[agent] ?? AGENT_FALLBACK}
            fillOpacity={0.7}
          />
        ))}
        {/* Left-axis trend line: total sessions per day. Same scale as the
            stacked bars, but the line reads as a distinct trend curve. */}
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="__total_sessions"
          name="total sessions"
          stroke="#0F172A"
          strokeWidth={2}
          dot={{ r: 2, fill: "#0F172A" }}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="__active_agents"
          name="active agents"
          stroke={HIGHLIGHT}
          strokeWidth={2}
          dot={{ r: 2, fill: HIGHLIGHT }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function SessionsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey: string;
    value: number;
    color: string;
    name: string;
    payload?: Record<string, number>;
  }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const bars = payload.filter(
    (p) => p.dataKey !== "__active_agents" && p.dataKey !== "__total_sessions",
  );
  const activeLine = payload.find((p) => p.dataKey === "__active_agents");
  const totalSessions = bars.reduce((sum, p) => sum + (p.value || 0), 0);

  return (
    <TooltipShell label={label}>
      <TooltipHeader label="Sessions" value={totalSessions} />
      {bars
        .filter((b) => b.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((b) => (
          <TooltipRow key={b.dataKey} color={b.color} label={b.name} value={b.value} />
        ))}
      {activeLine && (
        <>
          <TooltipDivider />
          <TooltipHeader label="active agents" value={activeLine.value} highlight />
        </>
      )}
    </TooltipShell>
  );
}

function EmptyChart() {
  return (
    <div className="h-48 flex items-center justify-center text-xs text-gray-400">
      no sessions yet — run the dashboard-intake workflow to populate
    </div>
  );
}
