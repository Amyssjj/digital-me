/**
 * Shared visual language for the §C Metrics view charts — ported from the
 * legacy mission-control GoalDetailSection (the pre-NUX implementation
 * that's being superseded). Preserves the user's expected chart aesthetic:
 *
 *   - Glass-card tooltips with backdrop-blur + soft shadow
 *   - Stable per-agent / per-domain color palette
 *   - Subtle CartesianGrid + axis styling (low-contrast greys)
 *   - Compact Legend with 10px font
 *
 * Each chart subcomponent imports these primitives so the dashboard reads
 * as one cohesive surface.
 */

import type { ReactNode } from "react";

// ── Palette ───────────────────────────────────────────────────────────────
//
// The pre-NUX dashboard's palette indexed agents by their project codenames
// (COO/CTO/YouTube/…). The NUX surfaces runtime IDs (claude-code/codex/…)
// — but we want the same hues so the visual rhythm carries over. Mapping
// the runtime IDs onto the same six colors keeps the muscle-memory.

export const AGENT_COLORS: Record<string, string> = {
  "claude-code": "#22D3EE", // cyan (was CPO)
  codex:         "#F59E0B", // amber (was COO)
  hermes:        "#A78BFA", // violet (was Writer)
  openclaw:      "#60A5FA", // blue   (was CTO)
};
export const AGENT_FALLBACK = "#9CA3AF";

/** Deterministic palette for domain bars. Same hues as the original chart
 *  so the four NUX metric panels share a coherent look. */
export const DOMAIN_PALETTE: ReadonlyArray<string> = [
  "#22D3EE", // cyan
  "#F59E0B", // amber
  "#A78BFA", // violet
  "#60A5FA", // blue
  "#FB7185", // rose
  "#34D399", // emerald
  "#FBBF24", // gold
  "#F472B6", // pink
  "#818CF8", // indigo
  "#FACC15", // yellow
  "#4ADE80", // lime
  "#94A3B8", // slate
];

export function domainColor(idx: number): string {
  return DOMAIN_PALETTE[idx % DOMAIN_PALETTE.length] ?? AGENT_FALLBACK;
}

/** Highlight color for the right-axis trend line (totals/rates). Matches
 *  the original Sessions/ConversionRate accent. */
export const HIGHLIGHT = "#F59E0B";
/** Secondary highlight — second trend line when two are needed. */
export const HIGHLIGHT_SECONDARY = "#FB7185";

// ── Chart layout constants ────────────────────────────────────────────────

export const CHART_MARGIN = { top: 8, right: 16, bottom: 4, left: 8 } as const;
export const GRID_STROKE = "rgba(0,0,0,0.04)";
export const AXIS_LINE = "rgba(0,0,0,0.06)";
export const AXIS_TICK_FILL = "#9CA3AF";

export const xAxisProps = {
  tick: { fontSize: 10, fill: AXIS_TICK_FILL },
  tickLine: false,
  axisLine: { stroke: AXIS_LINE },
  interval: "preserveStartEnd" as const,
};

export const yAxisProps = {
  tick: { fontSize: 10, fill: AXIS_TICK_FILL },
  tickLine: false,
  axisLine: false,
  width: 32,
  allowDecimals: false,
};

export const legendProps = {
  iconSize: 8,
  wrapperStyle: { fontSize: "10px", paddingTop: "4px" },
};

// ── Tooltip primitives ────────────────────────────────────────────────────

/** Outer envelope of every tooltip — glass-card aesthetic from the pre-NUX
 *  dashboard. */
export const TOOLTIP_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.97)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  border: "1px solid rgba(0,0,0,0.08)",
  borderRadius: "12px",
  padding: "10px 14px",
  fontSize: "11px",
  boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
  minWidth: "180px",
};

export function TooltipShell({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div style={TOOLTIP_STYLE}>
      {label ? (
        <div style={{ color: "#6B7280", fontSize: "10px", marginBottom: "6px" }}>
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function TooltipHeader({
  label,
  value,
  highlight,
}: {
  label: string;
  value: ReactNode;
  highlight?: boolean;
}) {
  const color = highlight ? HIGHLIGHT : "#1F2937";
  const valColor = highlight ? HIGHLIGHT : "#374151";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
      <span style={{ fontWeight: 600, color }}>{label}</span>
      <span style={{ fontWeight: 700, color: valColor }}>{value}</span>
    </div>
  );
}

export function TooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "2px",
            background: color,
            display: "inline-block",
          }}
        />
        <span style={{ color: "#6B7280", fontSize: "10px" }}>{label}</span>
      </span>
      <span style={{ fontWeight: 500, color: "#374151", fontSize: "10px" }}>{value}</span>
    </div>
  );
}

export function TooltipDivider() {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(0,0,0,0.06)",
        margin: "4px 0",
      }}
    />
  );
}

/** Compact y-axis label (uses original 9px style). */
export const Y_LABEL_STYLE = { fontSize: 9, fill: AXIS_TICK_FILL };

/** Format an ISO date as "MMM D" for x-axis ticks. */
export function formatDateShort(iso: string): string {
  // Defensive against non-ISO inputs.
  if (!iso || iso.length < 10) return iso;
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[parseInt(month, 10) - 1] ?? month;
  return `${m} ${parseInt(day, 10)}`;
}
