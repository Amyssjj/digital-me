import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { WorkflowTemplate, WorkflowStep } from "../hooks/useWorkflows";

// ══════════════════════════════════════════════════════
// DESIGN SYSTEM — matches TraceFlowCard exactly
// ══════════════════════════════════════════════════════

type NodeIdentity = "db" | "script" | "cron" | "agent" | "skill" | "jing" | "source" | "default";

const IDENTITY_COLORS: Record<NodeIdentity, { fill: string; text: string }> = {
  db:      { fill: "#F5E6D3", text: "#8B6914" },
  script:  { fill: "#B6CEB4", text: "#3A5239" },
  cron:    { fill: "#9ACBD0", text: "#2C5154" },
  agent:   { fill: "#9ACBD0", text: "#2C5154" },
  skill:   { fill: "#B6B09F", text: "#4A4738" },
  jing:    { fill: "#F0BB78", text: "#5C4520" },
  source:  { fill: "#D6A99D", text: "#5C3A32" },
  default: { fill: "#D9CFC7", text: "#4A4540" },
};

type ShapeKind = "cylinder" | "rect" | "pill" | "rounded";
const IDENTITY_SHAPE: Record<NodeIdentity, ShapeKind> = {
  db: "cylinder",
  script: "rect",
  cron: "pill",
  agent: "pill",
  skill: "rounded",
  jing: "rounded",
  source: "rounded",
  default: "rect",
};

const IDENTITY_LABELS: Record<NodeIdentity, string> = {
  db: "Database",
  script: "Script",
  cron: "Cron",
  agent: "Agent",
  skill: "Skill",
  jing: "Owner",
  source: "Source",
  default: "Step",
};

// Status colors for live run overlay
const RUN_STATUS_COLORS: Record<string, string> = {
  completed: "#059669",
  running:   "#3B82F6",
  failed:    "#DC2626",
  pending:   "#9CA3AF",
  cancelled: "#9CA3AF",
};

// Pulsing indicator for running steps
const RUNNING_PULSE_CLASS = "animate-pulse";

const NODE_W = 170;
const NODE_H = 38;
const GAP_X = 44;
const GAP_Y = 22;
const FONT_FAMILY = "'Work Sans', system-ui, sans-serif";
const LABEL_SIZE = "10";
const SUB_SIZE = "8";

// ══════════════════════════════════════════════════════
// STEP → NODE IDENTITY MAPPING (from migration plan)
// ══════════════════════════════════════════════════════

function getStepIdentity(dispatch: { mode: string; agentId?: string }): NodeIdentity {
  if (dispatch.mode === "approval") return "jing";
  if (dispatch.agentId === "coo") return "agent";
  if (dispatch.agentId === "main") return "cron";
  return "default";
}

// ══════════════════════════════════════════════════════
// DAG LAYOUT — topological sort using blockedByKeys
// ══════════════════════════════════════════════════════

interface StepNode {
  step: WorkflowStep;
  identity: NodeIdentity;
  layer: number;
  indexInLayer: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface DagLayout {
  nodes: StepNode[];
  edges: Array<{ fromKey: string; toKey: string }>;
  width: number;
  height: number;
}

function computeDagLayout(steps: WorkflowStep[]): DagLayout {
  const stepMap = new Map<string, WorkflowStep>();
  for (const s of steps) stepMap.set(s.stepKey, s);

  // Build adjacency
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const s of steps) {
    incoming.set(s.stepKey, new Set());
    outgoing.set(s.stepKey, new Set());
  }
  const edges: Array<{ fromKey: string; toKey: string }> = [];
  for (const s of steps) {
    for (const dep of s.blockedByKeys) {
      if (stepMap.has(dep)) {
        incoming.get(s.stepKey)?.add(dep);
        outgoing.get(dep)?.add(s.stepKey);
        edges.push({ fromKey: dep, toKey: s.stepKey });
      }
    }
  }

  // BFS layer assignment
  const layers = new Map<string, number>();
  const queue: string[] = [];
  for (const s of steps) {
    if (incoming.get(s.stepKey)?.size === 0) {
      layers.set(s.stepKey, 0);
      queue.push(s.stepKey);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layers.get(current)!;
    for (const next of outgoing.get(current) || []) {
      const existing = layers.get(next) ?? -1;
      if (currentLayer + 1 > existing) {
        layers.set(next, currentLayer + 1);
        queue.push(next);
      }
    }
  }
  // Handle unassigned (cycles or isolated)
  for (const s of steps) {
    if (!layers.has(s.stepKey)) layers.set(s.stepKey, 0);
  }

  // Group by layer
  const layerGroups = new Map<number, string[]>();
  for (const [key, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(key);
  }

  // Sort within each layer by sortOrder
  for (const [, keys] of layerGroups) {
    keys.sort((a, b) => (stepMap.get(a)?.sortOrder ?? 0) - (stepMap.get(b)?.sortOrder ?? 0));
  }

  const maxLayer = Math.max(...layers.values(), 0);
  const colWidth = NODE_W + GAP_X;

  const nodes: StepNode[] = [];
  for (let layer = 0; layer <= maxLayer; layer++) {
    const keys = layerGroups.get(layer) || [];
    for (let i = 0; i < keys.length; i++) {
      const step = stepMap.get(keys[i])!;
      const x = layer * colWidth;
      const y = i * (NODE_H + GAP_Y);
      nodes.push({
        step,
        identity: getStepIdentity(step.dispatch),
        layer,
        indexInLayer: i,
        x, y,
        cx: x + NODE_W / 2,
        cy: y + NODE_H / 2,
      });
    }
  }

  const maxNodesInLayer = Math.max(...[...layerGroups.values()].map(g => g.length), 1);
  const width = (maxLayer + 1) * colWidth - GAP_X;
  const height = maxNodesInLayer * (NODE_H + GAP_Y) - GAP_Y;

  return { nodes, edges, width, height };
}

// ══════════════════════════════════════════════════════
// SVG RENDERERS — same shapes/arrows as TraceFlowCard
// ══════════════════════════════════════════════════════

function renderStepNode(
  node: StepNode,
  taskStatus?: string,
) {
  const { x, y, cx, cy, identity, step } = node;
  const color = IDENTITY_COLORS[identity];
  const shape = IDENTITY_SHAPE[identity];
  const statusColor = taskStatus ? (RUN_STATUS_COLORS[taskStatus] || RUN_STATUS_COLORS.pending) : undefined;
  const label = step.name.length > 22 ? step.name.slice(0, 20) + "…" : step.name;
  const subText = step.dispatch.mode === "approval" ? "approval gate" : step.dispatch.agentId || "";

  return (
    <g key={step.stepKey}>
      {/* Shape */}
      {shape === "cylinder" ? (
        <>
          <path
            d={`M ${x} ${y + 6} Q ${x} ${y}, ${cx} ${y} Q ${x + NODE_W} ${y}, ${x + NODE_W} ${y + 6}
                L ${x + NODE_W} ${y + NODE_H - 6} Q ${x + NODE_W} ${y + NODE_H}, ${cx} ${y + NODE_H}
                Q ${x} ${y + NODE_H}, ${x} ${y + NODE_H - 6} Z`}
            fill={color.fill} stroke="#D4B896" strokeWidth={1}
          />
          <ellipse cx={cx} cy={y + 6} rx={NODE_W / 2} ry={6}
            fill={color.fill} stroke="#D4B896" strokeWidth={1}
          />
        </>
      ) : shape === "pill" ? (
        <rect x={x} y={y} width={NODE_W} height={NODE_H}
          rx={NODE_H / 2} ry={NODE_H / 2} fill={color.fill}
        />
      ) : shape === "rounded" ? (
        <rect x={x} y={y} width={NODE_W} height={NODE_H}
          rx={14} ry={14} fill={color.fill}
        />
      ) : (
        <rect x={x} y={y} width={NODE_W} height={NODE_H}
          rx={6} ry={6} fill={color.fill}
        />
      )}

      {/* Status dot — only if live run data exists */}
      {statusColor && (
        <circle cx={x + 10} cy={cy} r={3} fill={statusColor}>
          {taskStatus === "running" && (
            <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
          )}
        </circle>
      )}

      {/* Label */}
      <text x={x + (statusColor ? 18 : 12)} y={cy - (subText ? 4 : 0)}
        dominantBaseline="central" fill={color.text}
        fontSize={LABEL_SIZE} fontWeight="600" fontFamily={FONT_FAMILY}
      >
        {label}
      </text>

      {/* Sub-text — agent/mode */}
      {subText && (
        <text x={x + (statusColor ? 18 : 12)} y={cy + 10}
          dominantBaseline="central" fill={color.text}
          fontSize={SUB_SIZE} fontWeight="400" fontFamily={FONT_FAMILY}
          opacity={0.7}
        >
          {subText}
        </text>
      )}
    </g>
  );
}

function renderDagEdge(
  fromNode: StepNode,
  toNode: StepNode,
  i: number,
) {
  const color = "#C4C9CE";
  const x1 = fromNode.x + NODE_W;
  const y1 = fromNode.cy;
  const x2 = toNode.x;
  const y2 = toNode.cy;

  if (Math.abs(y1 - y2) < 2) {
    return (
      <g key={`edge-${i}`}>
        <line x1={x1} y1={y1} x2={x2 - 6} y2={y2} stroke={color} strokeWidth={1.5} />
        <polygon points={`${x2 - 6},${y2 - 4} ${x2},${y2} ${x2 - 6},${y2 + 4}`} fill={color} />
      </g>
    );
  } else {
    const midX = (x1 + x2) / 2;
    return (
      <g key={`edge-${i}`}>
        <path
          d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2 - 6} ${y2}`}
          stroke={color} strokeWidth={1.5} fill="none"
        />
        <polygon points={`${x2 - 6},${y2 - 4} ${x2},${y2} ${x2 - 6},${y2 + 4}`} fill={color} />
      </g>
    );
  }
}

// ══════════════════════════════════════════════════════
// IDENTITY LEGEND — same as TraceFlowCard
// ══════════════════════════════════════════════════════

function IdentityLegend({ identities }: { identities: NodeIdentity[] }) {
  const unique = [...new Set(identities)].filter(i => i !== "default");
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {unique.map(id => {
        const shape = IDENTITY_SHAPE[id];
        return (
          <div key={id} className="flex items-center gap-1.5">
            {shape === "cylinder" ? (
              <svg width="14" height="12" viewBox="0 0 14 12">
                <ellipse cx="7" cy="3" rx="6" ry="2.5" fill={IDENTITY_COLORS[id].fill} stroke="#D4B896" strokeWidth={0.5} />
                <rect x="1" y="3" width="12" height="6" fill={IDENTITY_COLORS[id].fill} />
                <ellipse cx="7" cy="9" rx="6" ry="2.5" fill={IDENTITY_COLORS[id].fill} stroke="#D4B896" strokeWidth={0.5} />
              </svg>
            ) : shape === "pill" ? (
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: IDENTITY_COLORS[id].fill }} />
            ) : shape === "rounded" ? (
              <span className="w-3 h-3 rounded-md" style={{ backgroundColor: IDENTITY_COLORS[id].fill }} />
            ) : (
              <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: IDENTITY_COLORS[id].fill }} />
            )}
            <span className="text-[9px] text-gray-400 font-medium">{IDENTITY_LABELS[id]}</span>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════
// DETAIL PANEL — slide-out, matches TraceDetail style
// ══════════════════════════════════════════════════════

function WorkflowDetail({ workflow, onClose }: { workflow: WorkflowTemplate; onClose: () => void }) {
  const dag = computeDagLayout(workflow.steps);
  const pad = 16;

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
        className="fixed top-0 right-0 h-full w-[560px] max-w-[90vw] bg-white shadow-2xl z-50 overflow-y-auto"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
      >
        <div className="p-6 space-y-6">
          <button
            onClick={onClose}
            className="absolute top-5 right-5 w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors text-sm font-bold cursor-pointer"
          >
            ✕
          </button>

          {/* Header */}
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">⚙️</span>
            <div>
              <h2 className="text-lg font-bold text-gray-800">{workflow.name}</h2>
              <p className="text-xs text-gray-400 mt-0.5">{workflow.description}</p>
              <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
                <span>v{workflow.version}</span>
                <span>·</span>
                <span>{workflow.steps.length} steps</span>
                <span>·</span>
                <span>{workflow.totalRuns} runs</span>
                {workflow.totalRuns > 0 && (
                  <>
                    <span>·</span>
                    <span>{Math.round(workflow.successRate)}% success</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Tags */}
          {workflow.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {workflow.tags.map(tag => (
                <span key={tag} className="text-[10px] px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 font-mono border border-gray-100">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* DAG in detail */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-[0.15em] mb-3">
              Workflow DAG
            </h3>
            <svg
              width={dag.width + pad * 2}
              viewBox={`${-pad} ${-pad} ${dag.width + pad * 2} ${dag.height + pad * 2}`}
              className="overflow-visible"
              style={{ maxWidth: "100%" }}
            >
              {dag.edges.map((edge, i) => {
                const fromNode = dag.nodes.find(n => n.step.stepKey === edge.fromKey);
                const toNode = dag.nodes.find(n => n.step.stepKey === edge.toKey);
                if (!fromNode || !toNode) return null;
                return renderDagEdge(fromNode, toNode, i);
              })}
              {dag.nodes.map(node => {
                const taskStatus = workflow.latestRun?.taskStatuses[node.step.name];
                return renderStepNode(node, taskStatus);
              })}
            </svg>
            <IdentityLegend identities={dag.nodes.map(n => n.identity)} />
          </div>

          <div className="border-t border-gray-100 my-4" />

          {/* Step details table */}
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-[0.15em] mb-3">
            Step Details
          </h3>
          <div className="space-y-2">
            {workflow.steps.map(step => {
              const identity = getStepIdentity(step.dispatch);
              const idColor = IDENTITY_COLORS[identity];
              const taskStatus = workflow.latestRun?.taskStatuses[step.name];
              const sColor = taskStatus ? (RUN_STATUS_COLORS[taskStatus] || RUN_STATUS_COLORS.pending) : undefined;

              return (
                <div
                  key={step.stepKey}
                  className="flex items-start hover:bg-gray-50/40 transition-colors rounded-lg px-3 py-2"
                >
                  <div className="relative shrink-0 flex items-center gap-1.5" style={{ width: 32 }}>
                    {sColor && (
                      <div
                        className={`w-3 h-3 rounded-full border-2 border-white shadow-sm ${taskStatus === "running" ? RUNNING_PULSE_CLASS : ""}`}
                        style={{ backgroundColor: sColor }}
                      />
                    )}
                    <div
                      className="w-2.5 h-2.5 rounded-sm"
                      style={{ backgroundColor: idColor.fill }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-700">{step.name}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-50 text-gray-400 font-mono shrink-0">
                        {IDENTITY_LABELS[identity]}
                      </span>
                      {step.dispatch.mode === "approval" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-mono shrink-0">
                          🔒 approval
                        </span>
                      )}
                      {taskStatus && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0"
                          style={{
                            backgroundColor: `${sColor}15`,
                            color: sColor,
                          }}
                        >
                          {taskStatus}
                        </span>
                      )}
                    </div>
                    {step.blockedByKeys.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        <span className="text-[9px] text-gray-400">blocked by:</span>
                        {step.blockedByKeys.map(dep => (
                          <span key={dep} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-50 text-gray-400 font-mono">
                            {dep}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Latest run info */}
          {workflow.latestRun && (
            <>
              <div className="border-t border-gray-100 my-4" />
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-[0.15em] mb-3">
                Latest Run
              </h3>
              <div className="flex flex-wrap gap-1.5">
                <span className="text-[10px] px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 font-mono border border-gray-100">
                  goal: {workflow.latestRun.goalId.slice(0, 8)}…
                </span>
                <span className="text-[10px] px-2.5 py-1 rounded-full font-mono border border-gray-100"
                  style={{
                    backgroundColor: `${RUN_STATUS_COLORS[workflow.latestRun.status] || "#9CA3AF"}15`,
                    color: RUN_STATUS_COLORS[workflow.latestRun.status] || "#9CA3AF",
                  }}
                >
                  {workflow.latestRun.status}
                </span>
                <span className="text-[10px] px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 font-mono border border-gray-100">
                  started: {new Date(workflow.latestRun.startedAt).toLocaleString()}
                </span>
                {workflow.latestRun.completedAt && (
                  <span className="text-[10px] px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 font-mono border border-gray-100">
                    completed: {new Date(workflow.latestRun.completedAt).toLocaleString()}
                  </span>
                )}
              </div>
            </>
          )}

          {/* Legend */}
          <div className="border-t border-gray-100 mt-6 pt-4">
            <div className="flex items-center gap-4">
              <span className="text-[9px] text-gray-400 uppercase tracking-wider font-semibold">Legend:</span>
              {(["agent", "cron", "jing", "default"] as NodeIdentity[]).map(id => (
                <div key={id} className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: IDENTITY_COLORS[id].fill }} />
                  <span className="text-[9px] text-gray-400">{IDENTITY_LABELS[id]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}

// ══════════════════════════════════════════════════════
// MAIN CARD — matches TraceFlowCard's outer shell
// ══════════════════════════════════════════════════════

export function WorkflowFlowCard({ workflow, index }: { workflow: WorkflowTemplate; index: number }) {
  const [showDetail, setShowDetail] = useState(false);
  const dag = computeDagLayout(workflow.steps);
  const pad = 12;

  const hasRun = workflow.latestRun !== null;
  const runStatus = workflow.latestRun?.status;
  const runStatusColor = runStatus ? (RUN_STATUS_COLORS[runStatus] || RUN_STATUS_COLORS.pending) : undefined;

  return (
    <>
      <motion.div
        className="relative cursor-pointer group"
        style={{
          borderRadius: "16px",
          background: "rgba(255, 255, 255, 0.55)",
          backdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.6)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.03)",
        }}
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, delay: index * 0.06 }}
        whileHover={{
          y: -4,
          boxShadow: "0 12px 40px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)",
        }}
        onClick={() => setShowDetail(true)}
      >
        <div className="p-4">
          {/* Header */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <span className="text-2xl">⚙️</span>
              <div>
                <h3 className="text-sm font-bold text-gray-800 leading-tight">
                  {workflow.name}
                </h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {hasRun ? (
                    <span className="inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${runStatusColor}15`,
                        color: runStatusColor,
                      }}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${runStatus === "running" ? RUNNING_PULSE_CLASS : ""}`}
                        style={{ backgroundColor: runStatusColor }}
                      />
                      {runStatus === "completed" ? "Latest Run ✓" : `Latest: ${runStatus}`}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-gray-50 text-gray-400">
                      Blueprint only
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">
                    📋 Workflow
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-3 text-[10px] text-gray-400 mb-3">
            <span className="flex items-center gap-1">
              <span className="text-gray-300">⬡</span>
              <span>{workflow.steps.length} steps</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-gray-300">🔄</span>
              <span>{workflow.totalRuns} runs</span>
            </span>
            {workflow.totalRuns > 0 && (
              <span className="flex items-center gap-1">
                <span className="text-gray-300">✓</span>
                <span>{Math.round(workflow.successRate)}% success</span>
              </span>
            )}
          </div>

          {/* SVG DAG */}
          {dag.nodes.length > 0 && (
            <>
              <svg
                width={dag.width + pad * 2}
                viewBox={`${-pad} ${-pad} ${dag.width + pad * 2} ${dag.height + pad * 2}`}
                className="overflow-visible"
                style={{ maxWidth: "100%" }}
              >
                {dag.edges.map((edge, i) => {
                  const fromNode = dag.nodes.find(n => n.step.stepKey === edge.fromKey);
                  const toNode = dag.nodes.find(n => n.step.stepKey === edge.toKey);
                  if (!fromNode || !toNode) return null;
                  return renderDagEdge(fromNode, toNode, i);
                })}
                {dag.nodes.map(node => {
                  const taskStatus = workflow.latestRun?.taskStatuses[node.step.name];
                  return renderStepNode(node, taskStatus);
                })}
              </svg>
              <IdentityLegend identities={dag.nodes.map(n => n.identity)} />
            </>
          )}
        </div>

        {/* Hover hint */}
        <div className="absolute inset-x-0 bottom-0 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-[9px] text-gray-300 font-medium">Click to expand workflow →</span>
        </div>
      </motion.div>

      <AnimatePresence>
        {showDetail && (
          <WorkflowDetail workflow={workflow} onClose={() => setShowDetail(false)} />
        )}
      </AnimatePresence>
    </>
  );
}
