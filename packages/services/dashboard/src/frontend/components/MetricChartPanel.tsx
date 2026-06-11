import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { useDateRange } from "../hooks/DateRangeContext";
import { SessionsByAgentChart } from "./metric-charts/SessionsByAgentChart";
import { KnowledgeTasteChangesChart } from "./metric-charts/KnowledgeTasteChangesChart";
import { ApplicationRateChart } from "./metric-charts/ApplicationRateChart";
import { DistributionRadarChart } from "./metric-charts/DistributionRadarChart";

export type MetricId =
  | "sessions-by-agent"
  | "knowledge-taste-changes"
  | "application-rate"
  | "distribution";

function endpointFor(metricId: MetricId, days: number): string {
  switch (metricId) {
    case "sessions-by-agent":       return `/api/metrics/sessions-by-agent?days=${days}`;
    case "knowledge-taste-changes": return `/api/metrics/knowledge-taste-changes?days=${days}`;
    case "application-rate":        return `/api/metrics/application-rate?days=${days}`;
    case "distribution":            return `/api/metrics/distribution`;
  }
}

const TITLE_BY_METRIC: Record<MetricId, string> = {
  "sessions-by-agent": "Daily sessions × active agents",
  "knowledge-taste-changes": "Knowledge + taste changes by domain",
  "application-rate": "Application rate (knowledges & tastes)",
  "distribution": "Knowledge + taste distribution",
};

// ── Metric definitions — slide-in panel content (mirrors the original
// legacy mission-control GoalDetailSection metrics-definition pattern). Each
// metric lists its datasource + per-sub-metric definition/calculation/purpose.

type MetricDef = {
  readonly name: string;
  readonly definition: string;
  readonly calculation: string;
  readonly purpose: string;
};
type MetricInfo = {
  readonly datasource: string;
  readonly metrics: ReadonlyArray<MetricDef>;
};

const METRIC_INFO: Record<MetricId, MetricInfo> = {
  "sessions-by-agent": {
    datasource: "dashboard.db → daa (populated by dashboard_intake.collect_transcripts)",
    metrics: [
      {
        name: "Total sessions",
        definition:
          "Distinct CLI/runtime sessions completed on a given day, broken down by agent_id.",
        calculation:
          "Walk each runtime's transcript dir (.claude/projects/, .codex/sessions/, .hermes/sessions/, .openclaw/agents/*/sessions/), count files whose mtime falls in [start, end], group by (agent_id, date).",
        purpose:
          "Track overall agent activity load + per-runtime utilization. Spot dormant runtimes vs. dominant ones.",
      },
      {
        name: "Active agents",
        definition:
          "Count of agents with at least one session on a given day.",
        calculation:
          "is_active = (sessions > 0 ? 1 : 0) per row; SUM(is_active) per day across the daa table.",
        purpose:
          "Track team-level participation breadth — is the system being used by 1 agent or 4?",
      },
    ],
  },
  "knowledge-taste-changes": {
    datasource:
      "dashboard.db → knowledge_taste_changes + knowledge_taste_distribution (populated by dashboard_intake.scan_knowledge_trees)",
    metrics: [
      {
        name: "Daily changes by domain",
        definition:
          "Number of wiki + taste files created or updated each day, per (tree, domain).",
        calculation:
          "rglob ~/digital-me/wiki/**/*.md and ~/digital-me/tastes/**/*.md; parse `created` and `updated` frontmatter dates; upsert (date, tree, domain, created_count, updated_count). Idempotent.",
        purpose:
          "See where the corpus is growing day-to-day. Surface the busiest domain in any given window.",
      },
      {
        name: "Wiki total (left-axis line)",
        definition: "Sum of (created + updated) across all wiki domains, per day.",
        calculation: "SUM(created + updated) WHERE tree='wiki' GROUP BY date.",
        purpose: "Top-line wiki write volume; trend curve overlaid on the stacked-bar breakdown.",
      },
      {
        name: "Tastes total (right-axis line)",
        definition: "Sum of (created + updated) across taste domains, per day.",
        calculation: "SUM(created + updated) WHERE tree='tastes' GROUP BY date.",
        purpose:
          "Track the dream-cycle taste-distill output. Independent right-axis scale so small taste counts stay legible.",
      },
      {
        name: "Distribution snapshot (radar, left card)",
        definition:
          "Per-domain file count at the moment scan_knowledge_trees ran (point-in-time stock).",
        calculation:
          "COUNT(*) of files per (tree, domain) after walking both trees; refresh `as_of` timestamp each run.",
        purpose:
          "See the corpus shape — which domains are deep vs. thin in wiki vs. tastes.",
      },
    ],
  },
  "application-rate": {
    datasource:
      "Three-source union (2026-05-27 cutover, see wiki: infrastructure/m1-universal-event-protocol.md): " +
      "(1) brain.db.m1_events (canonical, per-turn — knowledge_surfaced + assistant_ack events from every runtime); " +
      "(2) ~/.openclaw/data/m1_events_{claude_code,openclaw,hermes}.jsonl (raw event WAL — same shape as brain, durable local copy for backfill); " +
      "(3) ~/.claude/hooks/application_rate.log + ~/.openclaw/data/application_rate_{openclaw,hermes}.log (legacy session-aggregate — kept for historical days < 2026-05-27). " +
      "Aggregated by dashboard_intake.derive_application_rate (--source=all merges all three by per-key max() of distinct paths) into application_rate{,_by_domain,_by_agent}.",
    metrics: [
      {
        name: "M1 application rate",
        definition:
          "Per day, per tree: fraction of wiki paths surfaced to an agent that the agent applied — either via an opening tool call (memory_get / Read) OR an explicit acknowledgment in the assistant response.",
        calculation:
          "rate = |acted| / |surfaced|, where surfaced = union of paths in all knowledge_surfaced events for the day (deduped); acted = union of paths in assistant_ack events (deduped); memory/* and absolute paths excluded; cwd-relative paths normalised by stripping /wiki/ or /tastes/ prefix before classification.",
        purpose:
          "Measure whether agents are applying the knowledge being surfaced to them — the core flywheel signal.",
      },
      {
        name: "Surfaced unique",
        definition:
          "Distinct wiki / tastes paths that the recall plugin surfaced to the agent on a given day (across all turns and sessions, deduped per-path).",
        calculation:
          "Union of entries[].path across knowledge_surfaced events (brain + WAL) plus surfaced_paths arrays from the legacy session-aggregate JSONL records. Classified by /wiki/ or /tastes/ infix.",
        purpose: "Denominator of M1. Tracks recall-plugin coverage.",
      },
      {
        name: "Acted unique",
        definition:
          "Of the surfaced paths, the ones the agent applied — either by opening them via memory_get / Read, OR by explicit acknowledgment in the assistant's response (path/title mention or the canonical '[Digital Me] ...' directive being followed).",
        calculation:
          "Union of entries[].path across assistant_ack events (which carry the parser-detected acted subset) plus acted_paths arrays from the legacy JSONL session-aggregate records. The assistant_ack signal is what catches the case where the top-1 surfaced entry's body is inlined into the recall block — the LLM reads it without a follow-up tool call, which the legacy 'tool calls only' definition silently missed.",
        purpose:
          "Numerator of M1. Tracks downstream application behavior, including inlined-body reads that older tool-call-based measurement underestimated.",
      },
      {
        name: "By-domain + by-agent drilldown",
        definition:
          "Same M1 calculation but bucketed by domain (first path segment) or by agent_id (runtime).",
        calculation:
          "Same per-day union grouped by (date, tree, domain) and (date, tree, agent_id). agent_id comes from the brain m1_events.runtime column or from the legacy log file's runtime attribution.",
        purpose:
          "Drilldown: 'which domains are best-applied today?' and 'which runtime applies the wiki best?'",
      },
    ],
  },
  "distribution": {
    datasource:
      "Same as knowledge-taste-changes (knowledge_taste_distribution snapshot).",
    metrics: [
      {
        name: "Top-N domains by combined total",
        definition:
          "Top 8 domains ranked by (wiki + tastes) file count at the snapshot timestamp.",
        calculation: "SUM(total) GROUP BY domain ORDER BY SUM DESC LIMIT 8.",
        purpose: "Anchor for the radar axes — keeps the chart legible at a glance.",
      },
    ],
  },
};

export function MetricChartPanel({
  metricId,
  index,
}: {
  readonly metricId: MetricId;
  readonly index: number;
}) {
  const { days } = useDateRange();
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(endpointFor(metricId, days))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
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
  }, [metricId, days]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 * index }}
        className="glass-card h-full min-h-[260px] p-5 flex flex-col"
      >
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">{TITLE_BY_METRIC[metricId]}</h3>
          <button
            onClick={() => setShowDetails(true)}
            title={`How is "${TITLE_BY_METRIC[metricId]}" calculated?`}
            className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors cursor-pointer"
          >
            Metrics
          </button>
        </div>

        {/* Chart fills the rest of the card height so the right side aligns
            with the (possibly taller) left card. Each chart subcomponent
            uses ResponsiveContainer with height="100%" so it grows. */}
        <div className="flex-1 min-h-[200px]">
          {loading ? (
            <div className="h-full flex items-center justify-center text-xs text-gray-400">
              loading…
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center text-xs text-red-500 font-mono">
              {error}
            </div>
          ) : (
            <MetricChart metricId={metricId} data={data} />
          )}
        </div>
      </motion.div>

      {/* Slide-in metric definition panel — mirrors the original Mission
          Control GoalDetailSection slide-out pattern. */}
      <AnimatePresence>
        {showDetails && (
          <MetricsDefinitionPanel
            metricId={metricId}
            title={TITLE_BY_METRIC[metricId]}
            onClose={() => setShowDetails(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function MetricChart({
  metricId,
  data,
}: {
  readonly metricId: MetricId;
  readonly data: unknown;
}) {
  switch (metricId) {
    case "sessions-by-agent":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return <SessionsByAgentChart data={data as any} />;
    case "knowledge-taste-changes":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return <KnowledgeTasteChangesChart data={data as any} />;
    case "application-rate":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return <ApplicationRateChart data={data as any} />;
    case "distribution":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return <DistributionRadarChart data={data as any} />;
  }
}

function MetricsDefinitionPanel({
  metricId,
  title,
  onClose,
}: {
  readonly metricId: MetricId;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const info = METRIC_INFO[metricId];
  return (
    <>
      <motion.div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="fixed top-0 right-0 h-full w-[480px] max-w-[90vw] bg-white shadow-2xl z-50 overflow-y-auto"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
      >
        <div className="p-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-gray-800">{title}</h2>
              <p className="text-[10px] font-mono uppercase tracking-[0.15em] text-gray-400 mt-1">
                metric · {metricId}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-lg cursor-pointer leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Metrics Definition
            </h4>
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="text-[9px] text-gray-400">Datasource:</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                {info.datasource}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {info.metrics.map((m) => (
              <div
                key={m.name}
                className="rounded-xl border border-gray-100 bg-gray-50/50 p-4 space-y-2"
              >
                <h5 className="text-sm font-bold text-gray-800">{m.name}</h5>
                <div className="space-y-1.5">
                  <DefRow label="Definition" value={m.definition} />
                  <DefRow label="Calculation" value={m.calculation} mono />
                  <DefRow label="Purpose" value={m.purpose} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </>
  );
}

function DefRow({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 w-20 shrink-0 pt-0.5">
        {label}
      </span>
      <span className={`text-xs text-gray-600 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
