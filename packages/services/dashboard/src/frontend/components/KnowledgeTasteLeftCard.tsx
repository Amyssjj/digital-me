import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import { DistributionRadarChart } from "./metric-charts/DistributionRadarChart";

/**
 * NUX scope-down §C follow-up: left card for the "Knowledge & taste flow"
 * row. The radar that used to be its own row now lives here as a
 * point-in-time snapshot — making the whole second row about the corpus
 * (snapshot left, flow right):
 *
 *   Snapshot · distribution
 *   Total entries                  N
 *   ───────────────────────────────
 *   [radar chart]
 *
 * Fetches `/api/metrics/distribution` (point-in-time, ignores date range).
 */

type DistributionRow = {
  tree: "wiki" | "tastes";
  domain: string;
  total: number;
  as_of: string;
};

type DistributionResult = {
  rows: DistributionRow[];
  top_domains: string[];
};

export function KnowledgeTasteLeftCard({ index }: { readonly index: number }) {
  const [data, setData] = useState<DistributionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/metrics/distribution")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<DistributionResult>;
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
  }, []);

  const totals = useMemo(() => {
    if (!data) return { total: 0, wiki: 0, tastes: 0 };
    let wiki = 0;
    let tastes = 0;
    for (const r of data.rows) {
      if (r.tree === "wiki") wiki += r.total;
      else tastes += r.total;
    }
    return { total: wiki + tastes, wiki, tastes };
  }, [data]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.05 * index }}
      className="glass-card h-full min-h-[260px] p-5 flex flex-col"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-gray-500">Total entries</span>
        <span className="text-2xl font-semibold text-gray-800 tabular-nums">
          {loading ? "…" : error ? "—" : totals.total.toLocaleString()}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-end gap-3 text-[11px] font-mono">
        <span className="text-gray-500">
          wiki <span className="text-gray-700 font-semibold tabular-nums">{totals.wiki.toLocaleString()}</span>
        </span>
        <span className="text-gray-500">
          tastes <span className="text-gray-700 font-semibold tabular-nums">{totals.tastes.toLocaleString()}</span>
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
      ) : (
        <div className="flex-1">
          <DistributionRadarChart data={data} />
        </div>
      )}
    </motion.div>
  );
}
