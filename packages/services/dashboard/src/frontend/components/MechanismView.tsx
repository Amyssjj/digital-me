import { motion } from "framer-motion";

import { WorkflowFlowCard } from "./WorkflowFlowCard";
import { useMechanismWorkflows } from "../hooks/useMechanismWorkflows";
import type { WorkflowTemplate } from "../hooks/useWorkflows";

/**
 * NUX scope-down §D: rewritten Mechanism view.
 *
 * Renders ONLY workflows that pass the eligibility rule applied server-side:
 *
 *   display.mechanism_view ?? (steps.length >= 3)
 *
 * The trace cards and system-status cards that used to dominate this view
 * are gone — both surfaces leaked operational noise that didn't help the
 * user understand "what mechanisms run on my behalf and how."
 *
 * Each workflow renders as a WorkflowFlowCard (unchanged from before) so
 * the step-DAG visualization + live status carry over.
 */
export function MechanismView() {
  const { data, error, isLoading } = useMechanismWorkflows(60_000);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center space-y-4">
          <motion.div
            className="w-8 h-8 rounded-full border-2 border-gray-200 mx-auto"
            animate={{ rotate: 360 }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
            style={{ borderTopColor: "#60A5FA" }}
          />
          <p className="text-[10px] text-gray-400 uppercase tracking-[0.3em] font-mono">
            Loading mechanism view
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Failed to load mechanism workflows: {error}
      </div>
    );
  }

  const workflows = data?.workflows ?? [];

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-gray-100 bg-white p-5"
      >
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-[0.15em] mb-2">
          Mechanism view
        </h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Long-step workflows that teach you how the system works.{" "}
          <span className="text-gray-400">
            Inclusion rule: <code className="font-mono">{data?.rule}</code>
          </span>
        </p>
        <p className="mt-2 text-[11px] text-gray-400">
          {workflows.length} workflow{workflows.length === 1 ? "" : "s"} eligible. Toggle
          {" "}<code className="font-mono">display.mechanism_view</code>{" "}
          in a workflow JSON to override the default for that workflow.
        </p>
      </motion.div>

      {workflows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-4">
          {workflows.map((wf, index) => {
            // Adapt to the WorkflowTemplate shape WorkflowFlowCard expects.
            const adapted: WorkflowTemplate = {
              id: wf.id,
              name: wf.name,
              description: wf.description ?? "",
              version: wf.version ?? 1,
              tags: wf.tags ?? [],
              steps: wf.steps.map((s) => ({
                stepKey: s.stepKey,
                name: s.name,
                blockedByKeys: s.blockedByKeys ?? [],
                // WorkflowFlowCard expects a dispatch object — fill in a
                // minimal default since the inclusion-rule endpoint doesn't
                // surface dispatch details. Future: extend the endpoint to
                // pass dispatch.mode/agentId through.
                dispatch: { mode: "exec" },
                sortOrder: s.sortOrder ?? 0,
              })),
              latestRun: wf.latestRun ?? null,
              totalRuns: wf.totalRuns ?? 0,
              successRate: wf.successRate ?? 0,
            };
            return (
              <div key={wf.id} className="relative">
                <VisibilityBadge
                  explicit={wf.mechanismVisibility.explicit}
                  autoIncluded={wf.mechanismVisibility.autoIncluded}
                />
                <WorkflowFlowCard workflow={adapted} index={index} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VisibilityBadge({
  explicit,
  autoIncluded,
}: {
  readonly explicit: boolean;
  readonly autoIncluded: boolean;
}) {
  const label = explicit
    ? "explicit"
    : autoIncluded
      ? "auto · ≥3 steps"
      : "included";
  const tooltip = explicit
    ? "display.mechanism_view: true set in this workflow's JSON"
    : "auto-included because the workflow has ≥3 steps. Add display.mechanism_view: false to hide.";
  return (
    <span
      title={tooltip}
      className="absolute top-3 right-3 z-10 text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-50 text-gray-400 border border-gray-100"
    >
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white/40 p-12 text-center">
      <p className="text-sm text-gray-500">
        No mechanism-eligible workflows yet.
      </p>
      <p className="mt-2 text-xs text-gray-400 leading-relaxed max-w-md mx-auto">
        Run <code className="font-mono">digital-me install --runtime dream-cycle</code>{" "}
        and <code className="font-mono">--runtime dashboard</code> to bring in
        the two defaults, or add{" "}
        <code className="font-mono">display.mechanism_view: true</code> to one of
        your personal workflows.
      </p>
    </div>
  );
}
