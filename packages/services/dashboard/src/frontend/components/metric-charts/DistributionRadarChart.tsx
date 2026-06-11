import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

import {
  HIGHLIGHT,
  HIGHLIGHT_SECONDARY,
  TooltipHeader,
  TooltipRow,
  TooltipShell,
  legendProps,
} from "./chart-style";

type Row = {
  tree: "wiki" | "tastes";
  domain: string;
  total: number;
  as_of: string;
};

type Result = {
  rows: Row[];
  top_domains: string[];
};

/**
 * Metric #4: distribution radar. Axes = top N domains by combined total.
 * Two series (wiki + tastes), same tooltip language as the rest of the
 * metrics view.
 */
export function DistributionRadarChart({ data }: { data: Result | null }) {
  if (!data || data.rows.length === 0) {
    return <EmptyChart />;
  }

  const totals = new Map<string, { wiki: number; tastes: number }>();
  for (const d of data.top_domains) totals.set(d, { wiki: 0, tastes: 0 });
  for (const r of data.rows) {
    const slot = totals.get(r.domain);
    if (!slot) continue;
    if (r.tree === "wiki") slot.wiki = r.total;
    else slot.tastes = r.total;
  }
  const series = data.top_domains.map((domain) => {
    const slot = totals.get(domain) ?? { wiki: 0, tastes: 0 };
    return { domain, wiki: slot.wiki, tastes: slot.tastes };
  });

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={200}>
      <RadarChart data={series} margin={{ top: 8, right: 16, bottom: 4, left: 16 }}>
        <PolarGrid stroke="rgba(0,0,0,0.06)" />
        <PolarAngleAxis dataKey="domain" tick={{ fontSize: 10, fill: "#6B7280" }} />
        <PolarRadiusAxis tick={{ fontSize: 9, fill: "#9CA3AF" }} />
        <Radar
          name="wiki"
          dataKey="wiki"
          stroke={HIGHLIGHT}
          fill={HIGHLIGHT}
          fillOpacity={0.18}
          strokeWidth={2}
        />
        <Radar
          name="tastes"
          dataKey="tastes"
          stroke={HIGHLIGHT_SECONDARY}
          fill={HIGHLIGHT_SECONDARY}
          fillOpacity={0.18}
          strokeWidth={2}
        />
        <Tooltip content={<DistributionTooltip />} wrapperStyle={{ zIndex: 50 }} />
        <Legend {...legendProps} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

function DistributionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload?: { domain?: string } }>;
}) {
  if (!active || !payload?.length) return null;
  const domain = payload[0]?.payload?.domain ?? "";
  const wiki = payload.find((p) => p.name === "wiki");
  const tastes = payload.find((p) => p.name === "tastes");
  const total = (wiki?.value ?? 0) + (tastes?.value ?? 0);
  return (
    <TooltipShell label={domain}>
      <TooltipHeader label="Total" value={total} />
      {wiki && wiki.value > 0 && (
        <TooltipRow color={HIGHLIGHT} label="wiki" value={wiki.value} />
      )}
      {tastes && tastes.value > 0 && (
        <TooltipRow color={HIGHLIGHT_SECONDARY} label="tastes" value={tastes.value} />
      )}
    </TooltipShell>
  );
}

function EmptyChart() {
  return (
    <div className="h-48 flex items-center justify-center text-xs text-gray-400">
      no distribution snapshot yet — run scan-knowledge-trees first
    </div>
  );
}
