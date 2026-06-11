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
  CHART_MARGIN,
  GRID_STROKE,
  HIGHLIGHT,
  HIGHLIGHT_SECONDARY,
  TooltipDivider,
  TooltipHeader,
  TooltipRow,
  TooltipShell,
  Y_LABEL_STYLE,
  domainColor,
  formatDateShort,
  legendProps,
  xAxisProps,
  yAxisProps,
} from "./chart-style";

type Row = {
  date: string;
  tree: "wiki" | "tastes";
  domain: string;
  created: number;
  updated: number;
};

type Result = {
  rows: Row[];
  domains: string[];
};

/**
 * Metric #2: knowledge + taste changes per day.
 *
 * Per user feedback + dual-axis-time-series-chart-pattern:
 *   - Left axis = # of wikis: stacked bars by wiki domain (sum = daily
 *     wiki changes). Left scale matches the wiki magnitude (could be 10s
 *     per day).
 *   - Right axis = # of tastes: separate small-integer scale (~0..5) so
 *     the tastes line isn't crushed by the wiki scale.
 *
 * The per-domain tastes breakdown surfaces only in the tooltip.
 */
export function KnowledgeTasteChangesChart({ data }: { data: Result | null }) {
  if (!data || data.rows.length === 0) {
    return <EmptyChart />;
  }

  // Domains that actually appear in the wiki tree (those are the bars).
  const wikiDomains = Array.from(
    new Set(data.rows.filter((r) => r.tree === "wiki").map((r) => r.domain)),
  ).sort();
  const tasteDomains = Array.from(
    new Set(data.rows.filter((r) => r.tree === "tastes").map((r) => r.domain)),
  ).sort();

  const byDate = new Map<
    string,
    Record<string, number> & {
      date: string;
      dateLabel: string;
      __wiki_total: number;
      __tastes_total: number;
      __tastes_by_domain: Record<string, number>;
    }
  >();
  for (const r of data.rows) {
    const slot =
      byDate.get(r.date) ??
      ({
        date: r.date,
        dateLabel: formatDateShort(r.date),
        __wiki_total: 0,
        __tastes_total: 0,
        __tastes_by_domain: {},
      } as ReturnType<typeof byDate.get> & object);
    const change = r.created + r.updated;
    if (r.tree === "wiki") {
      slot[r.domain] = (slot[r.domain] ?? 0) + change;
      slot.__wiki_total += change;
    } else {
      slot.__tastes_total += change;
      slot.__tastes_by_domain[r.domain] =
        (slot.__tastes_by_domain[r.domain] ?? 0) + change;
    }
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
          label={{ value: "# of wikis", angle: -90, position: "insideLeft", style: Y_LABEL_STYLE }}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          {...yAxisProps}
          tick={{ fontSize: 10, fill: HIGHLIGHT_SECONDARY }}
          domain={[0, (dataMax: number) => Math.max(1, dataMax + 1)]}
          allowDecimals={false}
          label={{ value: "# of tastes", angle: 90, position: "insideRight", style: { ...Y_LABEL_STYLE, fill: HIGHLIGHT_SECONDARY } }}
        />
        <Tooltip
          content={<ChangesTooltip wikiDomains={wikiDomains} tasteDomains={tasteDomains} />}
          wrapperStyle={{ zIndex: 50 }}
        />
        <Legend {...legendProps} />
        {wikiDomains.map((domain, i) => (
          <Bar
            key={domain}
            yAxisId="left"
            dataKey={domain}
            stackId="wiki-changes"
            name={domain}
            fill={domainColor(i)}
            fillOpacity={0.7}
          />
        ))}
        {/* Left-axis trend line: total wiki changes per day. Same scale
            as the stacked bars, drawn as a dark line so the daily total
            reads as a distinct curve over the per-domain breakdown. */}
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="__wiki_total"
          name="wiki total"
          stroke="#0F172A"
          strokeWidth={2}
          dot={{ r: 2, fill: "#0F172A" }}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="__tastes_total"
          name="tastes total"
          stroke={HIGHLIGHT_SECONDARY}
          strokeWidth={2}
          dot={{ r: 2, fill: HIGHLIGHT_SECONDARY }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function ChangesTooltip({
  active,
  payload,
  label,
  wikiDomains,
  tasteDomains,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey: string;
    value: number;
    color: string;
    name: string;
    payload?: Record<string, unknown>;
  }>;
  label?: string;
  wikiDomains: string[];
  tasteDomains: string[];
}) {
  if (!active || !payload?.length) return null;
  const wikiBars = payload.filter(
    (p) => p.dataKey !== "__tastes_total" && p.dataKey !== "__wiki_total",
  );
  const tastesLine = payload.find((p) => p.dataKey === "__tastes_total");
  const wikiTotal = wikiBars.reduce((sum, p) => sum + (p.value || 0), 0);
  const tastesByDomain = (payload[0]?.payload?.__tastes_by_domain ?? {}) as Record<string, number>;

  return (
    <TooltipShell label={label}>
      <TooltipHeader label="Wikis" value={wikiTotal} />
      {wikiBars
        .filter((b) => b.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .map((b) => (
          <TooltipRow key={b.dataKey} color={b.color} label={b.name} value={b.value} />
        ))}
      {tastesLine && (
        <>
          <TooltipDivider />
          <TooltipHeader label="Tastes" value={tastesLine.value} highlight />
          {Object.entries(tastesByDomain)
            .filter(([, v]) => v > 0)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 4)
            .map(([domain, value]) => {
              const idx = tasteDomains.indexOf(domain);
              // Offset taste domain colors so they don't collide with wiki bar
              // colors visually — pick from the back half of the palette.
              const colorIdx = wikiDomains.length + (idx >= 0 ? idx : 0);
              return (
                <TooltipRow
                  key={domain}
                  color={domainColor(colorIdx)}
                  label={domain}
                  value={value}
                />
              );
            })}
        </>
      )}
    </TooltipShell>
  );
}

function EmptyChart() {
  return (
    <div className="h-48 flex items-center justify-center text-xs text-gray-400">
      no changes in window — wait for dream-cycle compile to land
    </div>
  );
}
