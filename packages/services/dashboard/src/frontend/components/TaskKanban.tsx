import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useDateRange } from "../hooks/DateRangeContext";
import { useKanban } from "../hooks/useKanban";
import type {
  KanbanGoal,
  KanbanTask,
  KanbanAttempt,
  GoalStatus,
  TaskStatus,
  TaskCheckpoint,
  KanbanStats,
  AgentGoalCount,
} from "../hooks/useKanban";

// ── Status mapping ─────────────────────────────────────────────────────
// Tasks can have lifecycle states beyond the 5 column statuses
// (ready, dispatched, stalled, awaiting_approval, acknowledged, skipped, blocked).
// Collapse them into the closest column for stats/bucketing.
//
// Goal-level mapping is intentionally *not* here — evergreen goals use a
// different status vocabulary (healthy/degraded/paused/retired) and are
// surfaced separately in the Layer Health strip. The Kanban server filters
// type='evergreen' out, so any goal that reaches this code is a project goal
// using the project status vocabulary.
function toColumnTaskStatus(raw: string): TaskStatus {
  switch (raw) {
    case "ready":
    case "dispatched":
    case "stalled":
    case "awaiting_approval":
    case "blocked":
      return "pending";
    case "acknowledged":
    case "skipped":
      return "completed";
    default:
      return raw as TaskStatus;
  }
}

// ── Design System Colors ──

const STATUS_COLORS: Record<string, string> = {
  pending: "#FBBF24",   // amber
  running: "#60A5FA",   // blue
  completed: "#34D399", // green
  failed: "#F87171",    // red
  cancelled: "#94A3B8", // slate
};

const STATUS_BG: Record<string, string> = {
  pending: "rgba(251,191,36,0.10)",
  running: "rgba(96,165,250,0.10)",
  completed: "rgba(52,211,153,0.10)",
  failed: "rgba(248,113,113,0.10)",
  cancelled: "rgba(148,163,184,0.08)",
};

const AGENT_COLORS: Record<string, string> = {
  coo: "#F59E0B",     // amber
  main: "#60A5FA",    // blue (CTO)
  youtube: "#FB7185", // rose
  writer: "#A78BFA",  // violet
  cpo: "#22D3EE",     // cyan
  podcast: "#34D399", // green
};

const AGENT_LABELS: Record<string, string> = {
  coo: "COO",
  main: "CTO",
  youtube: "YouTube",
  writer: "Writer",
  cpo: "CPO",
  podcast: "Podcast",
};

function agentColor(agentId: string | null): string {
  if (!agentId) return "#9CA3AF";
  return AGENT_COLORS[agentId] || "#9CA3AF";
}

function agentLabel(agentId: string | null): string {
  if (!agentId) return "Unknown";
  return AGENT_LABELS[agentId] || agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#F87171",
  high: "#FB923C",
  normal: "#9CA3AF",
  low: "#6B7280",
};

const COLUMN_CONFIG: { key: GoalStatus; label: string; icon: string }[] = [
  { key: "pending", label: "Pending", icon: "◎" },
  { key: "running", label: "Running", icon: "◉" },
  { key: "completed", label: "Done", icon: "◆" },
  { key: "failed", label: "Failed", icon: "✗" },
  { key: "cancelled", label: "Cancelled", icon: "⊘" },
];

// ── Helpers ──

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Stats Bar ──

// ── Agent Filter Bar ──

function AgentFilterBar({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents: AgentGoalCount[];
  selectedAgent: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      className="glass-card p-2.5 mb-4 flex flex-wrap items-center gap-2"
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mr-1">
        Agent
      </span>
      <motion.button
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        onClick={() => onSelect(null)}
        className="text-[10px] font-semibold px-3 py-1 rounded-full transition-all"
        style={{
          background: selectedAgent === null ? "rgba(107,114,128,0.15)" : "transparent",
          color: selectedAgent === null ? "#374151" : "#9CA3AF",
          border: selectedAgent === null ? "1px solid rgba(107,114,128,0.2)" : "1px solid transparent",
        }}
      >
        All
      </motion.button>
      {agents.map(({ agentId, goalCount }) => {
        const color = agentColor(agentId);
        const isSelected = selectedAgent === agentId;
        return (
          <motion.button
            key={agentId}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => onSelect(isSelected ? null : agentId)}
            className="text-[10px] font-semibold px-3 py-1 rounded-full transition-all flex items-center gap-1.5"
            style={{
              background: isSelected ? `${color}20` : "transparent",
              color: isSelected ? color : "#9CA3AF",
              border: isSelected ? `1px solid ${color}40` : "1px solid transparent",
            }}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: color }}
            />
            {agentLabel(agentId)}
            <span
              className="text-[9px] font-mono ml-0.5"
              style={{ opacity: 0.7 }}
            >
              {goalCount}
            </span>
          </motion.button>
        );
      })}
    </motion.div>
  );
}

// ── Stats Bar ──

function StatsBar({ stats }: { stats: KanbanStats }) {
  const goalEntries = Object.entries(stats.goals.byStatus).filter(([, v]) => v > 0);
  const taskEntries = Object.entries(stats.tasks.byStatus).filter(([, v]) => v > 0);

  return (
    <div className="glass-card p-3 mb-5 flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Goals
        </span>
        <span className="text-sm font-bold text-gray-700">{stats.goals.total}</span>
        <div className="flex gap-1.5">
          {goalEntries.map(([status, count]) => (
            <span
              key={status}
              className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                background: STATUS_BG[status],
                color: STATUS_COLORS[status],
              }}
            >
              {count} {status}
            </span>
          ))}
        </div>
      </div>
      <div className="w-px h-4 bg-gray-200" />
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Tasks
        </span>
        <span className="text-sm font-bold text-gray-700">{stats.tasks.total}</span>
        <div className="flex gap-1.5">
          {taskEntries.map(([status, count]) => (
            <span
              key={status}
              className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                background: STATUS_BG[status],
                color: STATUS_COLORS[status],
              }}
            >
              {count} {status}
            </span>
          ))}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <motion.div
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: STATUS_COLORS.running }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <span className="text-[10px] text-gray-400 font-mono">10s polling</span>
      </div>
    </div>
  );
}

// ── Checkpoint Progress Bar ──

function CheckpointBar({ checkpoint }: { checkpoint: TaskCheckpoint }) {
  const pct = Math.min(100, Math.max(0, checkpoint.progressPercent));
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-medium text-gray-500 truncate max-w-[70%]">
          {checkpoint.phase}
        </span>
        <span className="text-[9px] font-mono text-gray-400">{pct}%</span>
      </div>
      <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ background: STATUS_COLORS.running }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
      {checkpoint.blocker && (
        <p className="text-[9px] text-red-400 mt-0.5">⚠ {checkpoint.blocker}</p>
      )}
    </div>
  );
}

// ── Attempt History ──

function AttemptHistory({ attempts }: { attempts: KanbanAttempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">
        Attempts
      </span>
      {attempts.map((a) => (
        <div
          key={a.attemptId}
          className="flex items-center gap-2 text-[10px] px-2 py-1 rounded-lg"
          style={{ background: STATUS_BG[a.status] }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: STATUS_COLORS[a.status] }}
          />
          <span className="font-mono text-gray-500">#{a.attemptNumber}</span>
          <span
            className="font-medium"
            style={{ color: STATUS_COLORS[a.status] }}
          >
            {a.status}
          </span>
          <span className="text-gray-400 ml-auto">{timeAgo(a.startedAt)}</span>
          {a.failureReason && (
            <span className="text-red-400 truncate max-w-[120px]" title={a.failureReason}>
              {truncate(a.failureReason, 30)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Task Card ──

function TaskCard({
  task,
  allTasks,
  index,
}: {
  task: KanbanTask;
  allTasks: KanbanTask[];
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockerNames = task.blockedBy
    .map((id) => allTasks.find((t) => t.id === id)?.name || id.slice(0, 8))
    .filter(Boolean);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
      onClick={() => setExpanded(!expanded)}
      className="rounded-lg px-3 py-2 cursor-pointer transition-all hover:bg-gray-50/80"
      style={{
        borderLeft: `3px solid ${STATUS_COLORS[task.status]}`,
        background: expanded ? "rgba(255,255,255,0.6)" : "transparent",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: STATUS_COLORS[task.status] }}
          />
          <span className="text-[11px] font-semibold text-gray-700 truncate">
            {task.name}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {task.priority !== "normal" && (
            <span
              className="text-[8px] font-bold uppercase px-1 py-0.5 rounded"
              style={{
                color: PRIORITY_COLORS[task.priority],
                background: `${PRIORITY_COLORS[task.priority]}15`,
              }}
            >
              {task.priority}
            </span>
          )}
          <span
            className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
            style={{
              background: STATUS_BG[task.status],
              color: STATUS_COLORS[task.status],
            }}
          >
            {task.status}
          </span>
        </div>
      </div>

      {/* Dependency badges */}
      {blockerNames.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          <span className="text-[8px] text-gray-400">blocked by:</span>
          {blockerNames.map((name) => (
            <span
              key={name}
              className="text-[8px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-mono"
            >
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Checkpoint progress */}
      {task.latestCheckpoint && <CheckpointBar checkpoint={task.status === 'completed' ? { ...task.latestCheckpoint, progressPercent: 100 } : task.latestCheckpoint} />}

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 pt-2 border-t border-gray-100 space-y-1.5">
              {/* Task description */}
              <p className="text-[10px] text-gray-500 leading-relaxed line-clamp-3">
                {task.task}
              </p>

              {/* Meta row */}
              <div className="flex items-center gap-3 text-[9px] text-gray-400">
                {task.startedAt && <span>Started: {timeAgo(task.startedAt)}</span>}
                {task.completedAt && <span>Completed: {timeAgo(task.completedAt)}</span>}
                <span>Attempts: {task.attemptCount}</span>
              </div>

              {/* Latest output */}
              {task.latestOutput && (
                <div className="mt-1.5 p-2 rounded-lg bg-gray-50 border border-gray-100">
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400 block mb-1">
                    Output
                  </span>
                  <p className="text-[10px] text-gray-600 leading-relaxed whitespace-pre-wrap line-clamp-4">
                    {task.latestOutput}
                  </p>
                </div>
              )}

              {/* Failure reason */}
              {task.failureReason && (
                <div className="mt-1 p-2 rounded-lg bg-red-50/50 border border-red-100">
                  <span className="text-[9px] font-semibold text-red-400">Failure:</span>
                  <p className="text-[10px] text-red-500 mt-0.5">{task.failureReason}</p>
                </div>
              )}

              {/* Attempt history */}
              <AttemptHistory attempts={task.attempts} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Goal Card ──

function GoalCard({ goal, index }: { goal: KanbanGoal; index: number }) {
  const [expanded, setExpanded] = useState(goal.status === "running");
  const tasksByStatus = useMemo(() => {
    const m: Record<TaskStatus, KanbanTask[]> = {
      pending: [],
      running: [],
      completed: [],
      failed: [],
      cancelled: [],
    };
    for (const t of goal.tasks) {
      const bucket = m[toColumnTaskStatus(t.status)] ?? m.pending;
      bucket.push(t);
    }
    return m;
  }, [goal.tasks]);

  const completedCount = goal.tasks.filter((t) => t.status === "completed").length;
  const totalCount = goal.tasks.length;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, delay: index * 0.08, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="glass-card overflow-hidden"
      style={{ borderLeft: `4px solid ${STATUS_COLORS[goal.status]}` }}
    >
      {/* Goal Header */}
      <div
        className="p-4 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: STATUS_COLORS[goal.status] }}
              />
              <h3 className="text-sm font-semibold text-gray-800 truncate">
                {truncate(goal.name, 60)}
              </h3>
              {goal.agentId && (
                <span
                  className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded-full flex-shrink-0"
                  style={{
                    background: `${agentColor(goal.agentId)}18`,
                    color: agentColor(goal.agentId),
                    border: `1px solid ${agentColor(goal.agentId)}30`,
                  }}
                >
                  {agentLabel(goal.agentId)}
                </span>
              )}
            </div>
            {goal.description && (
              <p className="text-[10px] text-gray-400 mt-1 line-clamp-1 ml-4">
                {goal.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className="text-[9px] font-medium px-2 py-0.5 rounded-full"
              style={{
                background: STATUS_BG[goal.status],
                color: STATUS_COLORS[goal.status],
              }}
            >
              {goal.status}
            </span>
            <motion.span
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="text-gray-400 text-xs"
            >
              ▾
            </motion.span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3 ml-4 flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{
                background:
                  goal.status === "failed"
                    ? STATUS_COLORS.failed
                    : `linear-gradient(90deg, ${STATUS_COLORS.completed}, ${STATUS_COLORS.running})`,
              }}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
          </div>
          <span className="text-[10px] font-mono text-gray-400">
            {completedCount}/{totalCount}
          </span>
        </div>

        {/* Meta row */}
        <div className="mt-2 ml-4 flex items-center gap-4 text-[9px] text-gray-400">
          <span>by {goal.createdBy}</span>
          <span>updated {timeAgo(goal.updatedAt)}</span>
          {goal.sourceWorkflowId && (
            <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-400 font-mono">
              workflow
            </span>
          )}
        </div>
      </div>

      {/* Expanded: Task list with dependency flow */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-1">
              <div className="border-t border-gray-100 pt-3">
                {/* Dependency flow visualization */}
                <DependencyFlow tasks={goal.tasks} />

                {/* Tasks grouped: running first, then pending, then rest */}
                <div className="mt-2 space-y-1">
                  {[...tasksByStatus.running, ...tasksByStatus.pending, ...tasksByStatus.failed, ...tasksByStatus.completed, ...tasksByStatus.cancelled].map(
                    (task, i) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        allTasks={goal.tasks}
                        index={i}
                      />
                    )
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Dependency Flow Visualization ──

function DependencyFlow({ tasks }: { tasks: KanbanTask[] }) {
  if (tasks.length <= 1) return null;

  // Build an ordered task list showing dep relationships
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const edges: { from: string; to: string }[] = [];
  for (const t of tasks) {
    for (const dep of t.blockedBy) {
      if (taskMap.has(dep)) {
        edges.push({ from: dep, to: t.id });
      }
    }
  }

  if (edges.length === 0) return null;

  return (
    <div className="mb-2 p-2 rounded-lg bg-gray-50/50 border border-gray-100">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400 block mb-1.5">
        Task Flow
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {tasks.map((t, i) => {
          const hasOutgoing = edges.some((e) => e.from === t.id);
          return (
            <div key={t.id} className="flex items-center gap-1">
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{
                  background: STATUS_BG[t.status],
                  color: STATUS_COLORS[t.status],
                  fontWeight: t.status === "running" ? 600 : 400,
                }}
              >
                {t.name}
              </span>
              {hasOutgoing && (
                <span className="text-gray-300 text-[10px]">→</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Kanban Column ──

function KanbanColumnView({
  config,
  goals,
  index,
}: {
  config: { key: GoalStatus; label: string; icon: string };
  goals: KanbanGoal[];
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.1 }}
      className="flex-1 min-w-[320px]"
    >
      {/* Column header */}
      <div className="glass-card mb-3 p-3 rounded-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span style={{ color: STATUS_COLORS[config.key] }}>{config.icon}</span>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-gray-500">
              {config.label}
            </h2>
          </div>
          <span className="text-[10px] font-mono text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
            {goals.length}
          </span>
        </div>
      </div>

      {/* Goal cards */}
      <div className="space-y-3">
        <AnimatePresence mode="popLayout">
          {goals.map((goal, i) => (
            <GoalCard key={goal.id} goal={goal} index={i} />
          ))}
        </AnimatePresence>
        {goals.length === 0 && (
          <div className="text-center py-8">
            <p className="text-[10px] text-gray-300 uppercase tracking-widest">No goals</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Main Component ──

export function TaskKanban() {
  const { days } = useDateRange();
  const { data, error, isLoading } = useKanban(10_000, days);
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  // Filter goals by selected agent
  const filteredGoals = useMemo(() => {
    if (!data) return [];
    if (!selectedAgent) return data.goals;
    return data.goals.filter((g) => g.agentId === selectedAgent);
  }, [data, selectedAgent]);

  // Compute filtered stats
  const filteredStats = useMemo((): KanbanStats | null => {
    if (!data) return null;
    if (!selectedAgent) return data.stats;
    const goalsByStatus: Record<GoalStatus, number> = {
      pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    };
    const tasksByStatus: Record<TaskStatus, number> = {
      pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    };
    let totalTasks = 0;
    for (const g of filteredGoals) {
      if (g.status in goalsByStatus) goalsByStatus[g.status]++;
      for (const t of g.tasks) {
        const ts = toColumnTaskStatus(t.status);
        if (ts in tasksByStatus) tasksByStatus[ts]++;
        totalTasks++;
      }
    }
    return {
      goals: { total: filteredGoals.length, byStatus: goalsByStatus },
      tasks: { total: totalTasks, byStatus: tasksByStatus },
      agents: data.stats.agents,
    };
  }, [data, selectedAgent, filteredGoals]);

  // Bucket goals by status
  const columns = useMemo(() => {
    if (!data) return null;
    const buckets: Record<GoalStatus, KanbanGoal[]> = {
      pending: [],
      running: [],
      completed: [],
      failed: [],
      cancelled: [],
    };
    for (const g of filteredGoals) {
      const bucket = buckets[g.status];
      if (bucket) bucket.push(g);
    }
    return buckets;
  }, [data, filteredGoals]);

  // Filter out empty non-essential columns (keep pending, running, completed always)
  const visibleColumns = useMemo(() => {
    if (!columns) return [];
    return COLUMN_CONFIG.filter(
      (c) =>
        columns[c.key].length > 0 ||
        c.key === "pending" ||
        c.key === "running" ||
        c.key === "completed"
    );
  }, [columns]);

  // Loading state
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
            Loading Kanban
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !data) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="glass-card p-8 max-w-md text-center space-y-3">
          <p className="text-sm text-gray-600">Kanban API Error</p>
          <p className="text-xs text-gray-400 font-mono">{error}</p>
          <p className="text-[10px] text-gray-400">
            Ensure the API server is running with /api/kanban enabled
          </p>
        </div>
      </div>
    );
  }

  if (!data || !columns) return null;

  return (
    <div>
      {/* Stats overview */}
      <StatsBar stats={filteredStats!} />

      {/* Agent filter */}
      {(data.stats.agents?.length ?? 0) > 0 && (
        <AgentFilterBar
          agents={data.stats.agents}
          selectedAgent={selectedAgent}
          onSelect={setSelectedAgent}
        />
      )}

      {/* View toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode("board")}
            className={`text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full transition-all ${
              viewMode === "board"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-400 hover:text-gray-600"
            }`}
          >
            Board
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full transition-all ${
              viewMode === "list"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-400 hover:text-gray-600"
            }`}
          >
            List
          </button>
        </div>
        {data.pagination.hasMore && (
          <span className="text-[9px] text-gray-400">
            Showing {data.goals.length} of {data.pagination.total} goals
          </span>
        )}
      </div>

      {/* Board view */}
      {viewMode === "board" ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {visibleColumns.map((col, i) => (
            <KanbanColumnView
              key={col.key}
              config={col}
              goals={columns[col.key]}
              index={i}
            />
          ))}
        </div>
      ) : (
        /* List view — all goals sorted by status priority */
        <div className="space-y-3">
          {[
            ...columns.running,
            ...columns.failed,
            ...columns.pending,
            ...columns.completed,
            ...columns.cancelled,
          ].map((goal, i) => (
            <GoalCard key={goal.id} goal={goal} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
