import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

/* ── Types ────────────────────────────────────────────── */

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  emoji: string;
  activeSessions: number;
  lastActive: string;
}

export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  agent: string;
  agentName: string;
  agentEmoji: string;
  date: string;
  status: "active" | "completed" | "blocked" | "pending";
}

export interface CronJob {
  name: string;
  description: string;
  schedule: string;
  scheduleHuman: string;
  owner: string;
  ownerEmoji: string;
  lastRun: string;
  lastRunStatus: "success" | "failure";
  nextRun: string;
  isRunning: boolean;
}

export interface DashboardData {
  agents: AgentInfo[];
  workItems: WorkItem[];
  cronJobs: CronJob[];
  lastUpdated: string;
}

/* ── Helpers ──────────────────────────────────────────── */

// Shared team workspace root, configured via TEAM_WORKSPACE_ROOT env var
// (defined in shared/contracts/env.ts). When unset, team-aware views
// degrade gracefully — tryCmd / fs lookups simply return null and the
// dashboard renders the "no team workspace configured" state.
const TEAM_DIR = process.env.TEAM_WORKSPACE_ROOT || "";

function tryCmd(c: string): string | null {
  try {
    const raw = execSync(c, { timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return raw.split("\n").filter(l => !l.startsWith("[plugins]")).join("\n").trim();
  } catch {
    return null;
  }
}

function humanCron(expr: string, tz?: string): string {
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;
  const [min, hour, , , dow] = parts;
  const tzLabel = tz ? ` (${tz.split("/").pop()})` : "";
  if (min.startsWith("*/")) return `Every ${min.slice(2)} min`;
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hr`;
  if (dow === "*") return `Daily at ${hour}:${min.padStart(2, "0")}${tzLabel}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[Number(dow)] || dow} at ${hour}:${min.padStart(2, "0")}${tzLabel}`;
}

/* ── Agent Roster ─────────────────────────────────────── */

interface AgentRaw {
  id: string;
  name?: string;
  identityName?: string;
  identityEmoji?: string;
  workspace?: string;
}

function parseAgentRoster(): Map<string, { name: string; emoji: string; role: string; workspace: string }> {
  const map = new Map<string, { name: string; emoji: string; role: string; workspace: string }>();
  const raw = tryCmd("openclaw agents list --json 2>/dev/null");
  if (!raw) return map;

  try {
    const d = JSON.parse(raw);
    const list: AgentRaw[] = d.agents || d;
    if (!Array.isArray(list)) return map;

    for (const a of list) {
      const id = a.id;
      const ws = a.workspace || join(TEAM_DIR, `clawd-${id}`);

      // Try to read role from IDENTITY.md
      let role = "";
      const idPath = join(ws, "IDENTITY.md");
      if (existsSync(idPath)) {
        try {
          const md = readFileSync(idPath, "utf-8");
          const m = md.match(/\*\*Role:\*\*\s*(.+)/);
          if (m) role = m[1].trim();
        } catch {}
      }

      map.set(id, {
        name: a.identityName || a.name || id,
        emoji: a.identityEmoji || "\u{1F916}",
        role,
        workspace: ws,
      });
    }
  } catch {}
  return map;
}

/* ── Active Sessions Per Agent ────────────────────────── */

function countActiveSessions(): Map<string, { count: number; lastActive: string }> {
  const map = new Map<string, { count: number; lastActive: string }>();
  const raw = tryCmd("openclaw sessions --json --all-agents 2>/dev/null");
  if (!raw) return map;

  try {
    const d = JSON.parse(raw);
    const list = d.sessions || d;
    if (!Array.isArray(list)) return map;

    for (const s of list) {
      const agentId = s.agentId || "";
      const ageMs = s.ageMs || Infinity;
      const updatedAt = s.updatedAt ? new Date(s.updatedAt).toISOString() : "";
      const isActive = ageMs < 30 * 60 * 1000; // 30 min

      const existing = map.get(agentId) || { count: 0, lastActive: "" };
      if (isActive) existing.count++;
      if (updatedAt > existing.lastActive) existing.lastActive = updatedAt;
      map.set(agentId, existing);
    }
  } catch {}
  return map;
}

/* ── Memory File Parsing ──────────────────────────────── */

function detectStatus(text: string): WorkItem["status"] {
  const lower = text.toLowerCase();
  if (/\bapproved\b|\bcompleted?\b|\bdone\b|\bfinished\b|\bshipped\b|\bmerged\b|\bfixed\b/.test(lower)) return "completed";
  if (/\bblocked\b|\bfailed\b|\berror\b|\bbroke\b/.test(lower)) return "blocked";
  if (/\bpending\b|\bawaiting\b|\bwaiting\b|\bpaused\b|\btbd\b|\btodo\b/.test(lower)) return "pending";
  return "active";
}

function parseMemoryFile(
  filePath: string,
  agentId: string,
  agentName: string,
  agentEmoji: string,
  date: string
): WorkItem[] {
  const items: WorkItem[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return items;
  }

  const lines = content.split("\n");
  let currentTitle = "";
  let currentBullets: string[] = [];
  let sectionIndex = 0;

  function flush() {
    if (!currentTitle) return;
    // Skip meta-sections that aren't real tasks
    const skip = /^daily digest|^team status snapshot|^reflection|^lessons? learned|^post-approval/i;
    if (skip.test(currentTitle)) {
      currentTitle = "";
      currentBullets = [];
      return;
    }

    const summary = currentBullets
      .slice(0, 3)
      .map(b => b.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean)
      .join(" \u2022 ");

    const fullText = currentTitle + " " + currentBullets.join(" ");
    const status = detectStatus(fullText);

    items.push({
      id: `${agentId}-${date}-${sectionIndex}`,
      title: currentTitle.replace(/\*\*/g, "").trim(),
      summary: summary || "",
      agent: agentId,
      agentName,
      agentEmoji,
      date,
      status,
    });

    sectionIndex++;
    currentTitle = "";
    currentBullets = [];
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentTitle = line.replace(/^##\s*/, "").trim();
    } else if (/^[-*]\s/.test(line.trim()) && currentTitle) {
      currentBullets.push(line.trim());
    }
  }
  flush();

  return items;
}

function parseRecentMemory(
  agentMap: Map<string, { name: string; emoji: string; role: string; workspace: string }>
): WorkItem[] {
  const items: WorkItem[] = [];
  const today = new Date();

  // Check today and yesterday
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const d = new Date(today);
    d.setDate(d.getDate() - dayOffset);
    const dateStr = d.toISOString().split("T")[0];

    for (const [agentId, info] of agentMap) {
      const memDir = join(info.workspace, "memory");
      const filePath = join(memDir, `${dateStr}.md`);
      if (existsSync(filePath)) {
        items.push(...parseMemoryFile(filePath, agentId, info.name, info.emoji, dateStr));
      }
    }
  }

  // If no items from today/yesterday, go back further
  if (items.length === 0) {
    for (const [agentId, info] of agentMap) {
      const memDir = join(info.workspace, "memory");
      if (!existsSync(memDir)) continue;
      try {
        const files = readdirSync(memDir)
          .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .sort()
          .reverse()
          .slice(0, 2);
        for (const f of files) {
          const dateStr = f.replace(".md", "");
          items.push(...parseMemoryFile(join(memDir, f), agentId, info.name, info.emoji, dateStr));
        }
      } catch {}
    }
  }

  return items;
}

/* ── Cron Jobs ────────────────────────────────────────── */

function parseCronJobs(
  agentMap: Map<string, { name: string; emoji: string; role: string; workspace: string }>
): CronJob[] {
  const raw = tryCmd("openclaw cron list --json 2>/dev/null");
  if (!raw) return [];

  try {
    const d = JSON.parse(raw);
    const jobList = d.jobs || d;
    if (!Array.isArray(jobList)) return [];

    return jobList.map((j: any) => {
      const sched = j.schedule || {};
      const state = j.state || {};
      const payload = j.payload || {};
      const expr = sched.expr || sched.cron || "";
      const agentId = j.agentId || "";
      const agentInfo = agentMap.get(agentId);

      // Extract a short description from the payload message
      let desc = j.description || "";
      if (!desc && payload.message) {
        // Take first sentence or first 120 chars
        const msg = String(payload.message).replace(/\n/g, " ").trim();
        desc = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
      }

      return {
        name: String(j.name || j.id || ""),
        description: desc,
        schedule: expr,
        scheduleHuman: humanCron(expr, sched.tz),
        owner: agentId,
        ownerEmoji: agentInfo?.emoji || "\u{1F916}",
        lastRun: state.lastRunAtMs ? new Date(state.lastRunAtMs).toISOString() : "",
        lastRunStatus: (state.lastRunStatus === "ok" || state.lastStatus === "ok") ? "success" as const : "failure" as const,
        nextRun: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : "",
        isRunning: !!(state.lastRunAtMs && !state.lastRunStatus),
      };
    });
  } catch {
    return [];
  }
}

/* ── Main ─────────────────────────────────────────────── */

let cache: DashboardData | null = null, last = 0;

export function fetchDashboardData(): DashboardData {
  const now = Date.now();
  if (cache && now - last < 8000) return cache;

  const agentMap = parseAgentRoster();
  const sessionCounts = countActiveSessions();
  const workItems = parseRecentMemory(agentMap);
  const cronJobs = parseCronJobs(agentMap);

  const agents: AgentInfo[] = [];
  for (const [id, info] of agentMap) {
    const sc = sessionCounts.get(id) || { count: 0, lastActive: "" };
    agents.push({
      id,
      name: info.name,
      role: info.role,
      emoji: info.emoji,
      activeSessions: sc.count,
      lastActive: sc.lastActive,
    });
  }

  cache = {
    agents,
    workItems,
    cronJobs,
    lastUpdated: new Date().toISOString(),
  };

  last = now;
  return cache;
}
