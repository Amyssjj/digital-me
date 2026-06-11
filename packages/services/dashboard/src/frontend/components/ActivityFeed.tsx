import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Feed view — Substack-style agent-activity feed.
 *
 * Polls /api/activity-feed every 5s and renders each event as a feed post:
 * a round agent avatar (the runtime's logo), the agent's name + a verified
 * check, a relative timestamp, the headline, and a body preview. Captured /
 * applied learnings carry one attachment card PER learning — an applied event
 * that recalled several learnings shows them separately, each independently
 * previewable. Clicking an attachment slides in a right panel that renders that
 * learning's real markdown content. Data is read from the brain DB snapshot
 * (see server/activity-feed.ts).
 */

type ActivityKind = "captured" | "applied" | "workflow" | "taste";
type ActivityFilter = "all" | ActivityKind;

const FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "captured", label: "Captured" },
  { key: "applied", label: "Applied" },
  { key: "taste", label: "Taste" },
  { key: "workflow", label: "Workflows" },
];

interface Attachment {
  title: string;
  path: string | null;
  markdown: string | null;
}

interface ActivityItem {
  id: string;
  ts: string;
  agent_id: string;
  activity: ActivityKind;
  title: string;
  description: string | null;
  meta: string | null;
  attachments: Attachment[] | null;
}

/** What the right panel previews: one learning in the context of its event. */
interface PreviewTarget {
  item: ActivityItem;
  attachment: Attachment;
}

interface FeedResponse {
  items: ActivityItem[];
  latest_ts: string | null;
}

const POLL_INTERVAL_MS = 5000;
const PAGE_LIMIT = 100;

/**
 * Per-runtime identity: display name, the @handle shown under it, the logo
 * served from /public/logos, and a brand accent used for the verified check
 * and attachment hover. `brain` renders the brain glyph instead of a logo
 * (the dream-cycle's taste avatar). Every system agent resolves to a logo, so
 * the initials fallback is only for genuinely unknown ids.
 */
interface AgentMeta {
  name: string;
  handle: string;
  logo?: string;
  brain?: boolean;
  accent: string;
}

const OPENCLAW_LOGO = "/logos/openclaw.svg";

/**
 * Known runtime prefixes. An agent id is an *instance* of a runtime — the brain
 * records ids like `codex-video-factory`, `hermes-discord`, `claude-code-sprint5`
 * — so we match on prefix and collapse every instance to its canonical runtime
 * identity (name + logo). That answers "who is Codex Video Factory?" (a Codex
 * instance) and folds `hermes-discord` down to just Hermes.
 */
const RUNTIMES: { match: RegExp; meta: AgentMeta }[] = [
  { match: /^claude-code/, meta: { name: "Claude Code", handle: "claudecode", logo: "/logos/claude.svg", accent: "#D97757" } },
  { match: /^codex/, meta: { name: "Codex", handle: "codex", logo: "/logos/codex.svg", accent: "#0F172A" } },
  { match: /^hermes/, meta: { name: "Hermes", handle: "hermes", logo: "/logos/hermes.svg", accent: "#1E293B" } },
];

function agentMeta(agent: string): AgentMeta {
  const id = (agent || "").toLowerCase();
  // The dream-cycle distills taste principles — it gets the brain avatar.
  if (id === "dream-cycle") return { name: "Dream Cycle", handle: "dreamcycle", brain: true, accent: "#DB2777" };
  for (const r of RUNTIMES) if (r.match.test(id)) return r.meta;
  // Everything else (coo, podcast, youtube, orchestrator, …) is an
  // OpenClaw-runtime agent: keep its readable name, give it the OpenClaw logo.
  return {
    name: agent
      .split(/[-_]/)
      .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : s))
      .join(" "),
    handle: agent.replace(/[-_]/g, ""),
    logo: OPENCLAW_LOGO,
    accent: "#FF4D4D",
  };
}

/** Brain glyph — the "knowledge" mark for learnings, taste, and the
 *  dream-cycle avatar. Uses currentColor so it inherits the surrounding text
 *  color (white on an accent square, accent on a light pill). */
function BrainIcon({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M9.5 3.5A2.5 2.5 0 0 0 7 6a2.5 2.5 0 0 0-1.5 4.3A2.5 2.5 0 0 0 6 14.8 2.5 2.5 0 0 0 8.5 19a2 2 0 0 0 3.5-1.3V5a2 2 0 0 0-2.5-1.5Z" />
      <path d="M14.5 3.5A2.5 2.5 0 0 1 17 6a2.5 2.5 0 0 1 1.5 4.3A2.5 2.5 0 0 1 18 14.8 2.5 2.5 0 0 1 15.5 19a2 2 0 0 1-3.5-1.3V5a2 2 0 0 1 2.5-1.5Z" />
    </svg>
  );
}

const ACTIVITY_VERB: Record<ActivityKind, string> = {
  captured: "captured a learning",
  applied: "applied knowledge",
  workflow: "started a workflow",
  taste: "distilled a taste",
};

const ACTIVITY_BADGE: Record<ActivityKind, { label: string; cls: string; icon: string }> = {
  captured: { label: "Captured learning", cls: "bg-amber-50 text-amber-700 border-amber-200", icon: "✦" },
  applied: { label: "Applied learning", cls: "bg-cyan-50 text-cyan-700 border-cyan-200", icon: "↻" },
  workflow: { label: "Workflow", cls: "bg-violet-50 text-violet-700 border-violet-200", icon: "▸" },
  taste: { label: "Taste principle", cls: "bg-rose-50 text-rose-700 border-rose-200", icon: "◆" },
};

export function ActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const newIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Reset to the loading state when the filter changes so the feed doesn't
    // briefly show the previous filter's posts.
    setIsLoading(true);
    setItems([]);

    const fetchOnce = async () => {
      try {
        const res = await fetch(`/api/activity-feed?limit=${PAGE_LIMIT}&kind=${filter}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as FeedResponse;
        if (cancelled) return;
        setItems((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          for (const it of json.items) {
            if (!seen.has(it.id)) newIdsRef.current.add(it.id);
          }
          setTimeout(() => newIdsRef.current.clear(), 1500);
          return json.items;
        });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
        }
      }
    };
    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [filter]);

  return (
    <div className="space-y-5">
      {/* Masthead */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-gray-100 bg-white p-6"
      >
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-2xl font-serif font-semibold tracking-tight text-gray-900">Feed</h2>
            <p className="text-sm text-gray-500 mt-1">
              Learnings captured, knowledge applied, taste distilled, and workflows started across every runtime —
              newest first.
            </p>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-gray-300 whitespace-nowrap">
            live · {POLL_INTERVAL_MS / 1000}s · {items.length} post{items.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* Filter chips */}
        <div className="flex gap-2 mt-4">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                filter === f.key
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </motion.div>

      {isLoading && items.length === 0 ? (
        <div className="flex items-center justify-center py-24">
          <p className="text-[10px] text-gray-400 uppercase tracking-[0.3em] font-mono">Loading feed</p>
        </div>
      ) : error && items.length === 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Failed to load feed: {error}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-gray-100 bg-white py-16 text-center">
          <p className="text-sm text-gray-500">No {filter === "all" ? "activity" : `${filter} activity`} yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            Captured learnings, applied knowledge, and started workflows stream in here as the intake snapshots them
            from the brain.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-100 bg-white overflow-hidden">
          <ol>
            {items.map((it, i) => (
              <FeedPost
                key={it.id}
                item={it}
                isNew={newIdsRef.current.has(it.id)}
                isFirst={i === 0}
                onOpen={(attachment) => setPreview({ item: it, attachment })}
              />
            ))}
          </ol>
        </div>
      )}

      <PreviewPanel target={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

/** Round agent avatar — the runtime logo on a white disc, brain glyph for the
 *  dream-cycle, initials only for a genuinely unknown id. */
function Avatar({ agent, size = 44 }: { agent: string; size?: number }) {
  const m = agentMeta(agent);
  if (m.brain) {
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center rounded-full text-white"
        style={{ width: size, height: size, backgroundColor: m.accent }}
        title={m.name}
      >
        <BrainIcon size={size * 0.52} />
      </span>
    );
  }
  if (m.logo) {
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-white"
        style={{ width: size, height: size, boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.08)" }}
        title={m.name}
      >
        <img src={m.logo} alt={m.name} style={{ width: size * 0.56, height: size * 0.56 }} className="object-contain" />
      </span>
    );
  }
  const initials = agent.replace(/[-_]/g, "").slice(0, 2).toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
      style={{ width: size, height: size, backgroundColor: m.accent }}
      title={m.name}
    >
      {initials}
    </span>
  );
}

/** The orange verified check Substack shows next to known publications. */
function VerifiedCheck({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-label="verified" className="shrink-0">
      <path
        d="M12 2l2.4 1.8 3 .1 1 2.8 2.4 1.8-1 2.8 1 2.8-2.4 1.8-1 2.8-3 .1L12 22l-2.4-1.8-3-.1-1-2.8L3.2 15.5l1-2.8-1-2.8 2.4-1.8 1-2.8 3-.1L12 2z"
        fill={color}
      />
      <path d="M8.5 12.2l2.3 2.3 4.6-4.8" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FeedPost({
  item,
  isNew,
  isFirst,
  onOpen,
}: {
  item: ActivityItem;
  isNew: boolean;
  isFirst: boolean;
  onOpen: (attachment: Attachment) => void;
}) {
  const m = agentMeta(item.agent_id);
  // Every feed author is a real system agent (a runtime, the dream-cycle, or an
  // OpenClaw agent) — all carry the verified check.
  const verified = true;
  // One card per learning. Applied events that recalled several learnings are
  // separated here, each independently previewable. Fall back to a synthesized
  // single attachment for legacy rows written before the column existed.
  const attachments =
    item.attachments && item.attachments.length > 0
      ? item.attachments
      : item.activity === "captured" || item.activity === "applied" || item.activity === "taste"
        ? [{ title: item.title, path: null, markdown: null }]
        : [];

  return (
    <motion.li
      initial={isNew ? { backgroundColor: "rgba(251, 191, 36, 0.12)" } : false}
      animate={{ backgroundColor: "rgba(255,255,255,1)" }}
      transition={{ duration: 1.2 }}
      className={`px-5 py-5 ${isFirst ? "" : "border-t border-gray-100"}`}
    >
      <div className="flex items-start gap-3">
        <Avatar agent={item.agent_id} />

        <div className="min-w-0 flex-1">
          {/* Byline */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[15px] font-semibold text-gray-900">{m.name}</span>
            {verified ? <VerifiedCheck color={m.accent} /> : null}
            <span className="text-xs text-gray-300">·</span>
            <span className="text-xs text-gray-400 font-mono" title={new Date(item.ts).toLocaleString()}>
              {formatRelative(item.ts)}
            </span>
          </div>
          <p className="text-xs text-gray-400 -mt-0.5">
            @{m.handle} · {ACTIVITY_VERB[item.activity]}
          </p>

          {/* Headline — a captured learning's title is its full raw insight,
              which can run long and carry markdown/code. Strip the markup and
              clamp it to a teaser; the full rendered content opens in the
              preview panel. */}
          <p className="font-serif text-lg leading-snug text-gray-900 mt-2 line-clamp-3">{headline(item.title)}</p>

          {/* Body preview (omit for applied — the per-learning cards carry it) */}
          {item.description && item.activity !== "applied" ? (
            <p className="text-sm text-gray-500 mt-1.5 leading-relaxed line-clamp-2">{item.description}</p>
          ) : null}

          {/* One attachment card per learning — each opens its own preview */}
          {attachments.length > 0 ? (
            <div className="mt-3 space-y-2">
              {attachments.map((att, i) => (
                <AttachmentCard
                  key={`${att.path ?? att.title}-${i}`}
                  activity={item.activity}
                  attachment={att}
                  accent={m.accent}
                  onOpen={() => onOpen(att)}
                />
              ))}
            </div>
          ) : item.meta ? (
            <span className="inline-block mt-3 text-[10px] font-mono text-gray-400 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5">
              {item.meta}
            </span>
          ) : null}
        </div>
      </div>
    </motion.li>
  );
}

/** Substack-style file embed for a single learning: click to render its
 *  markdown in the right panel. */
function AttachmentCard({
  activity,
  attachment,
  accent,
  onOpen,
}: {
  activity: ActivityKind;
  attachment: Attachment;
  accent: string;
  onOpen: () => void;
}) {
  const badge = ACTIVITY_BADGE[activity];
  const subtitle = attachment.path || badge.label;
  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/60 px-3 py-2.5 text-left transition-colors hover:border-gray-300 hover:bg-gray-50"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
        style={{ backgroundColor: accent }}
        aria-hidden
      >
        {/* Attachments are always knowledge leaves (a learning or a taste
            principle) — the brain mark. Workflow events carry no attachments. */}
        {activity === "workflow" ? <span className="text-base">{badge.icon}</span> : <BrainIcon size={18} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-gray-800">{attachment.title}</span>
        <span className="block truncate text-[11px] text-gray-400 font-mono">{subtitle}</span>
      </span>
      <span className="text-xs font-medium text-gray-400 group-hover:text-gray-600 whitespace-nowrap">
        Preview →
      </span>
    </button>
  );
}

/** Right slide-over rendering one learning's real markdown content. */
function PreviewPanel({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  return (
    <AnimatePresence>
      {target ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-gray-900/20 backdrop-blur-[1px]"
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-gray-200 bg-white shadow-2xl"
          >
            <RenderedLearning target={target} onClose={onClose} />
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

/** Strip a leading YAML frontmatter block (`---` … `---`) so react-markdown
 *  renders the prose, not raw key/value lines. Returns the body unchanged when
 *  there's no frontmatter. */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  const after = md.indexOf("\n", end + 1);
  return after === -1 ? "" : md.slice(after + 1).replace(/^\s+/, "");
}

/** The "perfect rendered result" — one learning's real markdown, rendered. */
function RenderedLearning({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const { item, attachment } = target;
  const m = agentMeta(item.agent_id);
  const badge = ACTIVITY_BADGE[item.activity];
  const body = attachment.markdown ? stripFrontmatter(attachment.markdown) : "";

  return (
    <div>
      {/* Panel header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white/90 px-5 py-3 backdrop-blur">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge.cls}`}
        >
          {item.activity === "workflow" ? <span aria-hidden>{badge.icon}</span> : <BrainIcon size={12} />}
          {badge.label}
        </span>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          aria-label="Close preview"
        >
          ✕
        </button>
      </div>

      <article className="px-6 py-6">
        {/* Byline */}
        <div className="flex items-center gap-2.5">
          <Avatar agent={item.agent_id} size={36} />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold text-gray-900">{m.name}</span>
              <VerifiedCheck color={m.accent} />
            </div>
            <p className="text-xs text-gray-400" title={new Date(item.ts).toLocaleString()}>
              {new Date(item.ts).toLocaleString()}
            </p>
          </div>
        </div>

        {/* The learning's source path, if known */}
        {attachment.path ? (
          <span className="mt-4 inline-block rounded-md border border-gray-100 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-500">
            {attachment.path}
          </span>
        ) : null}

        {/* Real rendered markdown */}
        {body ? (
          <div className="markdown-body mt-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        ) : (
          <p className="mt-6 text-sm text-gray-400">
            No rendered content was captured for this learning.
          </p>
        )}
      </article>
    </div>
  );
}

/** A feed headline from a learning's raw text: drop fenced/inline code and
 *  markdown emphasis, then collapse whitespace, so a long code-laden insight
 *  reads as a clean one-liner. The full rendered markdown (with code blocks)
 *  lives in the preview panel. */
function headline(raw: string): string {
  return (raw || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "now", "3m", "2h", "Apr 27" — Twitter-style relative time. */
function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
