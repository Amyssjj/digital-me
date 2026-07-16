import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import { useDateRange } from "../hooks/DateRangeContext";
import { AGENT_COLORS, AGENT_FALLBACK } from "./metric-charts/chart-style";

/**
 * "Remote MCP clients" panel.
 *
 * External MCP clients — a second machine's Claude Code, a Codex CLI — reach the
 * brain over the Streamable-HTTP transport, attributed by the `X-Agent-Id`
 * header. They leave a footprint only in brain.db `traces`, never in the
 * openclaw agent roster, so no agent-card surfaces them. This table shows every
 * non-roster client seen in the window: who they are (runtime / version when
 * they called agent_identify), how many brain calls they made, and when they
 * were last active. Clients that never identified (e.g. the `unknown:mcp`
 * fallback bucket — MCP traffic with no agent id set) still appear, flagged so
 * their attribution gap is visible.
 */

type RemoteClient = {
  agent_id: string;
  runtime: string | null;
  version: string | null;
  capabilities: string[];
  identified: boolean;
  calls: number;
  first_active: string;
  last_active: string;
  kinds: Record<string, number>;
};

type Result = {
  clients: RemoteClient[];
  window_days: number;
  generated_at: string;
  error?: string;
};

/** Compact "3m / 5h / 2d ago" relative time from an ISO timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function RemoteClientsCard({ index = 0 }: { readonly index?: number }) {
  const { days } = useDateRange();
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/remote-clients?days=${days}`)
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

  const clients = data?.clients ?? [];
  // A transport read failure surfaces as `error` in the 200 body (the endpoint
  // degrades rather than 500-ing) — treat it like the fetch-level error.
  const errMsg = error ?? data?.error ?? null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 * index }}
      className="glass-card p-5"
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">
            Remote MCP clients
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            External CLIs reaching the brain over HTTP — not in the agent roster
          </p>
        </div>
        <span className="text-[11px] text-gray-400 tabular-nums">
          {loading ? "…" : errMsg ? "—" : `${clients.length} seen`}
        </span>
      </div>

      <div className="my-3 border-t border-gray-100" />

      {loading ? (
        <div className="py-8 text-center text-[11px] text-gray-400">
          loading…
        </div>
      ) : errMsg ? (
        <div className="py-8 text-center text-[11px] text-red-500 font-mono">
          {errMsg}
        </div>
      ) : clients.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-gray-400">
          no remote MCP clients seen in this window
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="font-medium pb-2 pr-3">Client</th>
                <th className="font-medium pb-2 pr-3">Runtime</th>
                <th className="font-medium pb-2 pr-3 text-right">Calls</th>
                <th className="font-medium pb-2 pr-3 text-right">Last active</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <ClientRow key={c.agent_id} client={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}

function ClientRow({ client }: { client: RemoteClient }) {
  const color = AGENT_COLORS[client.runtime ?? ""] ?? AGENT_FALLBACK;
  const kindSummary = Object.entries(client.kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}: ${n}`)
    .join(" · ");
  return (
    <tr className="border-t border-gray-50">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: color, opacity: 0.85 }}
          />
          <span
            className="text-gray-700 font-medium truncate max-w-[220px]"
            title={client.agent_id}
          >
            {client.agent_id}
          </span>
          {!client.identified && (
            <span
              className="text-[9px] uppercase tracking-wide text-amber-600 bg-amber-50 rounded px-1 py-0.5"
              title="No agent_identify / X-Agent-Id — attributed to a fallback bucket"
            >
              unidentified
            </span>
          )}
        </div>
      </td>
      <td className="py-2 pr-3 text-gray-500">
        {client.runtime ?? "—"}
        {client.version ? (
          <span className="text-gray-300"> · {client.version}</span>
        ) : null}
      </td>
      <td
        className="py-2 pr-3 text-right font-mono text-gray-700 tabular-nums"
        title={kindSummary || undefined}
      >
        {client.calls}
      </td>
      <td className="py-2 pr-3 text-right text-gray-500 tabular-nums whitespace-nowrap">
        {relativeTime(client.last_active)}
      </td>
    </tr>
  );
}
