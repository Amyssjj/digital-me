import { motion } from "framer-motion";

import { ApplicationRateLeftCard } from "./ApplicationRateLeftCard";
import { KnowledgeTasteLeftCard } from "./KnowledgeTasteLeftCard";
import { MetricChartPanel, type MetricId } from "./MetricChartPanel";
import { RemoteClientsCard } from "./RemoteClientsCard";
import { SessionsLeftCard } from "./SessionsLeftCard";

/**
 * NUX scope-down §C: Metrics view = three rows.
 *
 *   1. Daily activity   — left: per-agent sessions breakdown
 *                         right: stacked bars × active-agents line
 *   2. Knowledge & taste — left: distribution radar (point-in-time)
 *                          right: stacked changes × tastes-total line
 *   3. Application rate — left: placeholder (TBD)
 *                          right: dual-line wiki/tastes M1
 *
 * The original 4th "distribution" row was folded into row 2's left card
 * so the snapshot+flow live in one row.
 */

type MetricRow = {
  readonly id: MetricId;
  readonly label: string;
  readonly hint: string;
};

const ROWS: ReadonlyArray<MetricRow> = [
  {
    id: "sessions-by-agent",
    label: "Daily activity",
    hint: "Sessions × active agents. Left card surfaces per-agent totals.",
  },
  {
    id: "knowledge-taste-changes",
    label: "Knowledge & taste flow",
    hint: "Per-domain new + edited counts. Left card shows the current corpus distribution.",
  },
  {
    id: "application-rate",
    label: "Application rate (M1)",
    hint: "Per-agent rate — surfaced → acted across the window.",
  },
];

export function SystemHealth() {
  return (
    <div className="space-y-5">
      <div className="space-y-4">
        {ROWS.map((row, i) => (
          <div
            key={row.id}
            className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-stretch"
          >
            {row.id === "sessions-by-agent" ? (
              <SessionsLeftCard index={i} />
            ) : row.id === "knowledge-taste-changes" ? (
              <KnowledgeTasteLeftCard index={i} />
            ) : (
              <ApplicationRateLeftCard index={i} />
            )}
            <MetricChartPanel metricId={row.id} index={i} />
          </div>
        ))}
      </div>

      <RemoteClientsCard index={ROWS.length} />

      <motion.div
        className="text-center py-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
      >
        <span className="text-[10px] text-gray-300 font-mono tracking-wider uppercase">
          {(import.meta as { env?: { VITE_DASHBOARD_TITLE?: string } }).env
            ?.VITE_DASHBOARD_TITLE ?? "Digital Me Dashboard"} · NUX v2
        </span>
      </motion.div>
    </div>
  );
}
