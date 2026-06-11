/**
 * Dashboard data aggregation — reads agents, sessions, cron jobs, and recent
 * agent memory files and composes the legacy `/api/dashboard` payload.
 *
 * Compared to the upstream module, this rewrite:
 *   - takes its team-workspace root from caller config (was a hardcoded
 *     personal SSD path)
 *   - injects the shell exec function (was a module-level `tryCmd` using
 *     execSync) so tests can supply fakes without spawning processes
 *   - exposes pure parsers (`humanCron`, `detectStatus`, `parseMemoryFile`,
 *     `parseAgentRoster`, `parseCronJobs`) for direct testing
 *   - removes the module-level TTL cache; consumers can wrap with TtlCache
 *     if they want caching
 */

import fs from "node:fs";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentInfo = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly emoji: string;
  readonly activeSessions: number;
  readonly lastActive: string;
};

export type WorkItem = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly agent: string;
  readonly agentName: string;
  readonly agentEmoji: string;
  readonly date: string;
  readonly status: "active" | "completed" | "blocked" | "pending";
};

export type CronJob = {
  readonly name: string;
  readonly description: string;
  readonly schedule: string;
  readonly scheduleHuman: string;
  readonly owner: string;
  readonly ownerEmoji: string;
  readonly lastRun: string;
  readonly lastRunStatus: "success" | "failure";
  readonly nextRun: string;
  readonly isRunning: boolean;
};

export type DashboardData = {
  readonly agents: AgentInfo[];
  readonly workItems: WorkItem[];
  readonly cronJobs: CronJob[];
  readonly lastUpdated: string;
};

export type AgentRosterEntry = {
  readonly name: string;
  readonly emoji: string;
  readonly role: string;
  readonly workspace: string;
};

export type ExecFn = (command: string) => string | null;

const DEFAULT_EMOJI = "\u{1F916}"; // 🤖

// ── Pure helpers ────────────────────────────────────────────────────────────

function lastSlashSegment(s: string): string {
  const idx = s.lastIndexOf("/");
  return idx === -1 ? s : s.slice(idx + 1);
}

export function humanCron(expr: string, tz?: string): string {
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;
  const [min, hour, , , dow] = parts as [string, string, string, string, string];
  const tzLabel = tz !== undefined ? ` (${lastSlashSegment(tz)})` : "";
  if (min.startsWith("*/")) return `Every ${min.slice(2)} min`;
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hr`;
  if (dow === "*") {
    return `Daily at ${hour}:${min.padStart(2, "0")}${tzLabel}`;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayLabel = days[Number(dow)] ?? dow;
  return `${dayLabel} at ${hour}:${min.padStart(2, "0")}${tzLabel}`;
}

export function detectStatus(text: string): WorkItem["status"] {
  const lower = text.toLowerCase();
  if (
    /\bapproved\b|\bcompleted?\b|\bdone\b|\bfinished\b|\bshipped\b|\bmerged\b|\bfixed\b/.test(
      lower,
    )
  ) {
    return "completed";
  }
  if (/\bblocked\b|\bfailed\b|\berror\b|\bbroke\b/.test(lower)) return "blocked";
  if (/\bpending\b|\bawaiting\b|\bwaiting\b|\bpaused\b|\btbd\b|\btodo\b/.test(lower)) {
    return "pending";
  }
  return "active";
}

// ── Memory file parsing ────────────────────────────────────────────────────

export function parseMemoryFile(input: {
  filePath: string;
  agentId: string;
  agentName: string;
  agentEmoji: string;
  date: string;
}): WorkItem[] {
  const { filePath, agentId, agentName, agentEmoji, date } = input;
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const items: WorkItem[] = [];
  let currentTitle = "";
  let currentBullets: string[] = [];
  let sectionIndex = 0;

  const skipPattern =
    /^daily digest|^team status snapshot|^reflection|^lessons? learned|^post-approval/i;

  function flush(): void {
    if (currentTitle === "") return;
    if (skipPattern.test(currentTitle)) {
      currentTitle = "";
      currentBullets = [];
      return;
    }
    const summary = currentBullets
      .slice(0, 3)
      .map((b) => b.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean)
      .join(" • ");
    const fullText = currentTitle + " " + currentBullets.join(" ");
    items.push({
      id: `${agentId}-${date}-${sectionIndex}`,
      title: currentTitle.replace(/\*\*/g, "").trim(),
      summary,
      agent: agentId,
      agentName,
      agentEmoji,
      date,
      status: detectStatus(fullText),
    });
    sectionIndex++;
    currentTitle = "";
    currentBullets = [];
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentTitle = line.replace(/^##\s*/, "").trim();
    } else if (/^[-*]\s/.test(line.trim()) && currentTitle !== "") {
      currentBullets.push(line.trim());
    }
  }
  flush();
  return items;
}

// ── Roster parsing ─────────────────────────────────────────────────────────

type AgentRaw = {
  readonly id: string;
  readonly name?: string;
  readonly identityName?: string;
  readonly identityEmoji?: string;
  readonly workspace?: string;
};

function readRoleFromIdentity(workspace: string): string {
  const idPath = path.join(workspace, "IDENTITY.md");
  if (!fs.existsSync(idPath)) return "";
  let md: string;
  try {
    md = fs.readFileSync(idPath, "utf-8");
  } catch {
    return "";
  }
  const m = md.match(/\*\*Role:\*\*\s*(.+)/);
  if (m === null) return "";
  // The single capture group is `.+` which is always defined when the regex
  // matches; assert non-null to skip the unreachable undefined branch.
  return m[1]!.trim();
}

export function parseAgentRoster(input: {
  exec: ExecFn;
  teamRoot: string;
}): Map<string, AgentRosterEntry> {
  const map = new Map<string, AgentRosterEntry>();
  const raw = input.exec("openclaw agents list --json 2>/dev/null");
  if (raw === null) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }

  const list =
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { agents?: unknown[] }).agents)
      ? (parsed as { agents: unknown[] }).agents
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : null;

  if (list === null) return map;

  for (const entry of list) {
    const a = entry as AgentRaw;
    const id = a.id;
    if (typeof id !== "string" || id === "") continue;
    const ws =
      typeof a.workspace === "string" && a.workspace !== ""
        ? a.workspace
        : path.join(input.teamRoot, `clawd-${id}`);
    map.set(id, {
      name: a.identityName ?? a.name ?? id,
      emoji: a.identityEmoji ?? DEFAULT_EMOJI,
      role: readRoleFromIdentity(ws),
      workspace: ws,
    });
  }
  return map;
}

// ── Active session counts ──────────────────────────────────────────────────

type SessionRaw = {
  readonly agentId?: string;
  readonly ageMs?: number;
  readonly updatedAt?: string;
};

const ACTIVE_AGE_MS = 30 * 60 * 1000;

function countActiveSessions(
  exec: ExecFn,
): Map<string, { count: number; lastActive: string }> {
  const map = new Map<string, { count: number; lastActive: string }>();
  const raw = exec("openclaw sessions --json --all-agents 2>/dev/null");
  if (raw === null) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }

  const list =
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { sessions?: unknown[] }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : null;

  if (list === null) return map;

  for (const entry of list) {
    const s = entry as SessionRaw;
    const agentId = typeof s.agentId === "string" ? s.agentId : "";
    const ageMs = typeof s.ageMs === "number" ? s.ageMs : Infinity;
    // Validate before formatting: `new Date("not-a-date").toISOString()` throws
    // RangeError, so one malformed timestamp from `openclaw sessions --json`
    // would otherwise crash the entire dashboard payload.
    const parsed =
      typeof s.updatedAt === "string" ? new Date(s.updatedAt) : null;
    const updatedAt =
      parsed && Number.isFinite(parsed.getTime())
        ? parsed.toISOString()
        : "";
    const existing = map.get(agentId) ?? { count: 0, lastActive: "" };
    if (ageMs < ACTIVE_AGE_MS) existing.count++;
    if (updatedAt > existing.lastActive) existing.lastActive = updatedAt;
    map.set(agentId, existing);
  }
  return map;
}

// ── Cron parsing ───────────────────────────────────────────────────────────

type CronJobRaw = {
  readonly id?: string;
  readonly name?: string;
  readonly agentId?: string;
  readonly description?: string;
  readonly schedule?: {
    readonly expr?: string;
    readonly cron?: string;
    readonly tz?: string;
  };
  readonly state?: {
    readonly lastRunAtMs?: number;
    readonly lastRunStatus?: string;
    readonly lastStatus?: string;
    readonly nextRunAtMs?: number;
  };
  readonly payload?: {
    readonly message?: string;
  };
};

export function parseCronJobs(input: {
  exec: ExecFn;
  agentMap: Map<string, AgentRosterEntry>;
}): CronJob[] {
  const raw = input.exec("openclaw cron list --json 2>/dev/null");
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list =
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { jobs?: unknown[] }).jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : null;
  if (list === null) return [];

  return list.map((entry) => {
    const j = entry as CronJobRaw;
    const sched = j.schedule ?? {};
    const state = j.state ?? {};
    const payload = j.payload ?? {};
    const expr = sched.expr ?? sched.cron ?? "";
    const agentId = j.agentId ?? "";
    const agentInfo = input.agentMap.get(agentId);

    let desc = j.description ?? "";
    if (desc === "" && typeof payload.message === "string") {
      const msg = payload.message.replace(/\n/g, " ").trim();
      desc = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
    }

    const lastRunAt = state.lastRunAtMs;
    const nextRunAt = state.nextRunAtMs;
    const status: "success" | "failure" =
      state.lastRunStatus === "ok" || state.lastStatus === "ok"
        ? "success"
        : "failure";

    return {
      name: String(j.name ?? j.id ?? ""),
      description: desc,
      schedule: expr,
      scheduleHuman: humanCron(expr, sched.tz),
      owner: agentId,
      ownerEmoji: agentInfo?.emoji ?? DEFAULT_EMOJI,
      lastRun: typeof lastRunAt === "number" ? new Date(lastRunAt).toISOString() : "",
      lastRunStatus: status,
      nextRun: typeof nextRunAt === "number" ? new Date(nextRunAt).toISOString() : "",
      isRunning:
        typeof lastRunAt === "number" &&
        state.lastRunStatus === undefined,
    };
  });
}

// ── Recent memory aggregation ──────────────────────────────────────────────

function parseRecentMemory(input: {
  agentMap: Map<string, AgentRosterEntry>;
  now: Date;
}): WorkItem[] {
  const items: WorkItem[] = [];
  // Today + yesterday
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const d = new Date(input.now);
    d.setDate(d.getDate() - dayOffset);
    const dateStr = d.toISOString().slice(0, 10);
    for (const [agentId, info] of input.agentMap) {
      const filePath = path.join(info.workspace, "memory", `${dateStr}.md`);
      items.push(
        ...parseMemoryFile({
          filePath,
          agentId,
          agentName: info.name,
          agentEmoji: info.emoji,
          date: dateStr,
        }),
      );
    }
  }

  if (items.length > 0) return items;

  // Walk back further per agent (up to 2 most-recent date-named files).
  for (const [agentId, info] of input.agentMap) {
    const memDir = path.join(info.workspace, "memory");
    if (!fs.existsSync(memDir)) continue;
    let files: string[];
    try {
      files = fs
        .readdirSync(memDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, 2);
    } catch {
      continue;
    }
    for (const f of files) {
      const dateStr = f.replace(".md", "");
      items.push(
        ...parseMemoryFile({
          filePath: path.join(memDir, f),
          agentId,
          agentName: info.name,
          agentEmoji: info.emoji,
          date: dateStr,
        }),
      );
    }
  }
  return items;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export function buildDashboardData(input: {
  exec: ExecFn;
  teamRoot: string;
  now: () => Date;
}): DashboardData {
  const agentMap = parseAgentRoster({
    exec: input.exec,
    teamRoot: input.teamRoot,
  });
  const sessionCounts = countActiveSessions(input.exec);
  const workItems = parseRecentMemory({ agentMap, now: input.now() });
  const cronJobs = parseCronJobs({ exec: input.exec, agentMap });

  const agents: AgentInfo[] = [];
  for (const [id, info] of agentMap) {
    const sc = sessionCounts.get(id) ?? { count: 0, lastActive: "" };
    agents.push({
      id,
      name: info.name,
      role: info.role,
      emoji: info.emoji,
      activeSessions: sc.count,
      lastActive: sc.lastActive,
    });
  }

  return {
    agents,
    workItems,
    cronJobs,
    lastUpdated: input.now().toISOString(),
  };
}
