/**
 * Cross-Session Pattern Propagation — Phase 2B
 *
 * v0.7.1 fix: H2 — correction uniqueSessions now counted per-tool, not global
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const CROSS_SESSION_FILE = path.join(FORGE_DIR, "cross-session-patterns.json");

interface PatternEntry {
  ts: string;
  tool: string;
  args_summary: string | null;
  success: boolean;
  session: string | null;
  type?: string;
  error?: string | null;
  tools?: string[];
  text_fragment?: string;
  [key: string]: unknown;
}

export interface ToolStat {
  totalAcrossSessions: number;
  uniqueSessions: number;
  successRate: number;
  commonArgs: string[];
  commonErrors: string[];
  lastSeen: string;
  sessionList: string[];
}

export interface CorrectionCluster {
  totalCorrections: number;
  uniqueSessions: number;
  phrases: string[];
  sessionIds: string[]; // H2 fix: track per-tool session IDs
}

export interface CrossSessionChain {
  occurrences: number;
  sessions: string[];
}

export interface CrossSessionState {
  version: number;
  updated: string;
  toolStats: Record<string, ToolStat>;
  correctionClusters: Record<string, CorrectionCluster>;
  crossSessionChains: Record<string, CrossSessionChain>;
}

function loadState(): CrossSessionState {
  try {
    if (fsSync.existsSync(CROSS_SESSION_FILE)) {
      return JSON.parse(fsSync.readFileSync(CROSS_SESSION_FILE, "utf-8"));
    }
  } catch { /* fresh start */ }
  return {
    version: 1,
    updated: new Date().toISOString(),
    toolStats: {},
    correctionClusters: {},
    crossSessionChains: {},
  };
}

function saveState(state: CrossSessionState): void {
  try {
    state.updated = new Date().toISOString();
    fsSync.writeFileSync(CROSS_SESSION_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error(`[aceforge/cross-session] Failed to save state: ${(err as Error).message}`);
  }
}

function readPatterns(): PatternEntry[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) as PatternEntry; } catch { return null; } })
    .filter(Boolean) as PatternEntry[];
}

function extractArgTokens(argsSummary: string): string[] {
  if (!argsSummary) return [];
  return argsSummary
    .replace(/[{}":\[\]]/g, " ")
    .split(/[\s,]+/)
    .filter(t => t.length > 2)
    .map(t => t.toLowerCase())
    .slice(0, 10);
}

const TOOL_BLOCKLIST = new Set([
  "forge", "forge_status", "forge_reflect", "forge_propose",
  "forge_approve_skill", "forge_reject_skill", "forge_quality",
  "forge_registry", "forge_rewards", "forge_gaps",
  "sessions_spawn", "sessions_list", "sessions_send", "sessions_history",
  "process",
]);

export function mergePatterns(): CrossSessionState {
  const state = loadState();
  const patterns = readPatterns();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const toolStats: Record<string, ToolStat> = {};
  const correctionClusters: Record<string, CorrectionCluster> = {};
  const chainMap: Record<string, { sessions: Set<string>; count: number }> = {};

  for (const p of patterns) {
    if (new Date(p.ts).getTime() < cutoff) continue;

    if (p.type !== "correction" && p.type !== "chain" && p.tool && !TOOL_BLOCKLIST.has(p.tool)) {
      if (!toolStats[p.tool]) {
        toolStats[p.tool] = {
          totalAcrossSessions: 0, uniqueSessions: 0, successRate: 0,
          commonArgs: [], commonErrors: [], lastSeen: p.ts, sessionList: [],
        };
      }
      const stat = toolStats[p.tool];
      stat.totalAcrossSessions++;
      if (p.session && !stat.sessionList.includes(p.session)) {
        stat.sessionList.push(p.session);
      }
      if (new Date(p.ts).getTime() > new Date(stat.lastSeen).getTime()) {
        stat.lastSeen = p.ts;
      }
      if (p.args_summary) {
        for (const token of extractArgTokens(p.args_summary)) {
          if (!stat.commonArgs.includes(token)) {
            stat.commonArgs.push(token);
            if (stat.commonArgs.length > 20) stat.commonArgs.shift();
          }
        }
      }
      if (!p.success && p.error) {
        const errKey = (typeof p.error === "string" ? p.error : "").slice(0, 60);
        if (errKey && !stat.commonErrors.includes(errKey)) {
          stat.commonErrors.push(errKey);
          if (stat.commonErrors.length > 10) stat.commonErrors.shift();
        }
      }
    }

    // Corrections — H2 fix: track session IDs per tool
    if (p.type === "correction") {
      const nearestTool = patterns.find(np =>
        np.type !== "correction" && np.type !== "chain" &&
        np.session === p.session && np.tool &&
        Math.abs(new Date(np.ts).getTime() - new Date(p.ts).getTime()) < 120000
      );
      const tool = nearestTool?.tool || "_unattributed";
      if (!correctionClusters[tool]) {
        correctionClusters[tool] = { totalCorrections: 0, uniqueSessions: 0, phrases: [], sessionIds: [] };
      }
      const cluster = correctionClusters[tool];
      cluster.totalCorrections++;
      const phrase = (p.text_fragment || "").slice(0, 80);
      if (phrase && !cluster.phrases.includes(phrase)) {
        cluster.phrases.push(phrase);
        if (cluster.phrases.length > 10) cluster.phrases.shift();
      }
      // H2 fix: track THIS tool's correction sessions
      if (p.session && !cluster.sessionIds.includes(p.session)) {
        cluster.sessionIds.push(p.session);
      }
    }

    if (p.type === "chain" && p.tools && Array.isArray(p.tools)) {
      const key = (p.tools as string[]).join("→");
      if (!chainMap[key]) chainMap[key] = { sessions: new Set(), count: 0 };
      chainMap[key].count++;
      if (p.session) chainMap[key].sessions.add(p.session);
    }
  }

  for (const [tool, stat] of Object.entries(toolStats)) {
    stat.uniqueSessions = stat.sessionList.length;
    const toolPatterns = patterns.filter(p =>
      p.tool === tool && p.type !== "correction" && p.type !== "chain" &&
      new Date(p.ts).getTime() >= cutoff
    );
    const successes = toolPatterns.filter(p => p.success).length;
    stat.successRate = toolPatterns.length > 0 ? Math.round((successes / toolPatterns.length) * 100) / 100 : 0;
  }

  // H2 fix: use per-tool session IDs for uniqueSessions count
  for (const [, cluster] of Object.entries(correctionClusters)) {
    cluster.uniqueSessions = cluster.sessionIds.length;
  }

  const crossSessionChains: Record<string, CrossSessionChain> = {};
  for (const [key, data] of Object.entries(chainMap)) {
    if (data.sessions.size >= 2) {
      crossSessionChains[key] = { occurrences: data.count, sessions: [...data.sessions] };
    }
  }

  state.toolStats = toolStats;
  state.correctionClusters = correctionClusters;
  state.crossSessionChains = crossSessionChains;
  saveState(state);
  return state;
}

export interface CrossSessionCandidate {
  tool: string;
  reason: "high_cross_session_usage" | "cross_session_corrections" | "cross_session_chain";
  sessions: number;
  occurrences: number;
  detail: string;
}

export function getCrossSessionCandidates(minSessions: number = 3): CrossSessionCandidate[] {
  const state = loadState();
  if (!state.toolStats) return [];
  const candidates: CrossSessionCandidate[] = [];

  for (const [tool, stat] of Object.entries(state.toolStats)) {
    if (stat.uniqueSessions >= minSessions && stat.totalAcrossSessions >= 5) {
      candidates.push({
        tool, reason: "high_cross_session_usage", sessions: stat.uniqueSessions,
        occurrences: stat.totalAcrossSessions,
        detail: `${stat.totalAcrossSessions}x across ${stat.uniqueSessions} sessions (${Math.round(stat.successRate * 100)}% success)`,
      });
    }
  }

  for (const [tool, cluster] of Object.entries(state.correctionClusters)) {
    if (tool === "_unattributed") continue;
    if (cluster.uniqueSessions >= 2 && cluster.totalCorrections >= 3) {
      candidates.push({
        tool, reason: "cross_session_corrections", sessions: cluster.uniqueSessions,
        occurrences: cluster.totalCorrections,
        detail: `${cluster.totalCorrections} corrections across ${cluster.uniqueSessions} sessions: ${cluster.phrases.slice(0, 2).join("; ")}`,
      });
    }
  }

  for (const [chain, data] of Object.entries(state.crossSessionChains)) {
    if (data.sessions.length >= minSessions) {
      candidates.push({
        tool: chain, reason: "cross_session_chain", sessions: data.sessions.length,
        occurrences: data.occurrences,
        detail: `Pipeline ${chain} used ${data.occurrences}x across ${data.sessions.length} sessions`,
      });
    }
  }

  candidates.sort((a, b) => b.sessions - a.sessions);
  return candidates;
}

export function formatCrossSessionReport(): string {
  const state = mergePatterns();
  const candidates = getCrossSessionCandidates();
  let text = `Cross-Session Pattern Report (${new Date(state.updated).toLocaleString()})\n\n`;

  const sortedTools = Object.entries(state.toolStats)
    .filter(([, s]) => s.uniqueSessions >= 2)
    .sort(([, a], [, b]) => b.uniqueSessions - a.uniqueSessions)
    .slice(0, 10);

  if (sortedTools.length > 0) {
    text += `Top Cross-Session Tools:\n`;
    for (const [tool, stat] of sortedTools) {
      text += `  ${tool}: ${stat.totalAcrossSessions}x across ${stat.uniqueSessions} sessions (${Math.round(stat.successRate * 100)}% success)\n`;
    }
    text += `\n`;
  }

  const corrections = Object.entries(state.correctionClusters)
    .filter(([t, c]) => t !== "_unattributed" && c.totalCorrections >= 2);
  if (corrections.length > 0) {
    text += `Recurring Corrections (cross-session):\n`;
    for (const [tool, cluster] of corrections) {
      text += `  ${tool}: ${cluster.totalCorrections} corrections across ${cluster.uniqueSessions} sessions — "${cluster.phrases[0] || ""}"\n`;
    }
    text += `\n`;
  }

  const chains = Object.entries(state.crossSessionChains)
    .filter(([, c]) => c.sessions.length >= 2)
    .sort(([, a], [, b]) => b.sessions.length - a.sessions.length);
  if (chains.length > 0) {
    text += `Cross-Session Workflows:\n`;
    for (const [chain, data] of chains.slice(0, 5)) {
      text += `  ${chain}: ${data.occurrences}x across ${data.sessions.length} sessions\n`;
    }
    text += `\n`;
  }

  if (candidates.length > 0) {
    text += `Skill Generation Candidates:\n`;
    for (const c of candidates.slice(0, 5)) {
      text += `  ${c.tool}: ${c.detail}\n`;
    }
  } else {
    text += `No cross-session candidates yet. Need more diverse session data.\n`;
  }

  return text;
}
