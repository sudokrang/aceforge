/**
 * Cross-Session Pattern Propagation — Phase 2B
 *
 * Aggregates tool usage patterns across all sessions to identify global recurring
 * patterns that only become visible when you look at the agent's entire history.
 * Single-session analysis misses patterns that span Telegram + Slack + iMessage + cron.
 *
 * Research: Memento-Skills (arXiv:2603.18743) — skills as persistent evolving memory;
 * Read-Write Reflective Learning enables carrying forward knowledge across interactions.
 * Memento (arXiv:2508.16153) — Memory-augmented MDP; case-based reasoning.
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const CROSS_SESSION_FILE = path.join(FORGE_DIR, "cross-session-patterns.json");

// ─── Types ──────────────────────────────────────────────────────────────

interface PatternEntry {
  ts: string;
  tool: string;
  args_summary: string | null;
  success: boolean;
  session: string | null;
  type?: string;
  error?: string | null;
  tools?: string[];
  correctedArgs?: string;
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

// ─── Load/Save ──────────────────────────────────────────────────────────

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

// ─── Pattern Reading ────────────────────────────────────────────────────

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

// ─── Token Extraction ───────────────────────────────────────────────────

function extractArgTokens(argsSummary: string): string[] {
  if (!argsSummary) return [];
  // Extract meaningful tokens from args (field names, paths, commands)
  return argsSummary
    .replace(/[{}":\[\]]/g, " ")
    .split(/[\s,]+/)
    .filter(t => t.length > 2)
    .map(t => t.toLowerCase())
    .slice(0, 10);
}

// ─── Merge Patterns ─────────────────────────────────────────────────────

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

  // Reset for fresh computation
  const toolStats: Record<string, ToolStat> = {};
  const correctionClusters: Record<string, CorrectionCluster> = {};
  const chainMap: Record<string, { sessions: Set<string>; count: number }> = {};

  // Process tool traces
  for (const p of patterns) {
    if (new Date(p.ts).getTime() < cutoff) continue;

    // Tool traces
    if (p.type !== "correction" && p.type !== "chain" && p.tool && !TOOL_BLOCKLIST.has(p.tool)) {
      if (!toolStats[p.tool]) {
        toolStats[p.tool] = {
          totalAcrossSessions: 0,
          uniqueSessions: 0,
          successRate: 0,
          commonArgs: [],
          commonErrors: [],
          lastSeen: p.ts,
          sessionList: [],
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
      // Accumulate arg tokens
      if (p.args_summary) {
        for (const token of extractArgTokens(p.args_summary)) {
          if (!stat.commonArgs.includes(token)) {
            stat.commonArgs.push(token);
            if (stat.commonArgs.length > 20) stat.commonArgs.shift(); // keep recent
          }
        }
      }
      // Accumulate errors
      if (!p.success && p.error) {
        const errKey = (typeof p.error === "string" ? p.error : "").slice(0, 60);
        if (errKey && !stat.commonErrors.includes(errKey)) {
          stat.commonErrors.push(errKey);
          if (stat.commonErrors.length > 10) stat.commonErrors.shift();
        }
      }
    }

    // Corrections
    if (p.type === "correction") {
      // Find which tool this correction is about
      const nearestTool = patterns.find(np =>
        np.type !== "correction" && np.type !== "chain" &&
        np.session === p.session && np.tool &&
        Math.abs(new Date(np.ts).getTime() - new Date(p.ts).getTime()) < 120000
      );
      const tool = nearestTool?.tool || "_unattributed";
      if (!correctionClusters[tool]) {
        correctionClusters[tool] = { totalCorrections: 0, uniqueSessions: 0, phrases: [] };
      }
      const cluster = correctionClusters[tool];
      cluster.totalCorrections++;
      const phrase = ((p as any).text_fragment || "").slice(0, 80);
      if (phrase && !cluster.phrases.includes(phrase)) {
        cluster.phrases.push(phrase);
        if (cluster.phrases.length > 10) cluster.phrases.shift();
      }
    }

    // Chains
    if (p.type === "chain" && p.tools && Array.isArray(p.tools)) {
      const key = (p.tools as string[]).join("→");
      if (!chainMap[key]) chainMap[key] = { sessions: new Set(), count: 0 };
      chainMap[key].count++;
      if (p.session) chainMap[key].sessions.add(p.session);
    }
  }

  // Compute derived stats
  for (const [tool, stat] of Object.entries(toolStats)) {
    stat.uniqueSessions = stat.sessionList.length;
    const toolPatterns = patterns.filter(p =>
      p.tool === tool && p.type !== "correction" && p.type !== "chain" &&
      new Date(p.ts).getTime() >= cutoff
    );
    const successes = toolPatterns.filter(p => p.success).length;
    stat.successRate = toolPatterns.length > 0 ? Math.round((successes / toolPatterns.length) * 100) / 100 : 0;
  }

  // Compute correction session counts
  for (const [tool, cluster] of Object.entries(correctionClusters)) {
    const corrPatterns = patterns.filter(p => p.type === "correction" && new Date(p.ts).getTime() >= cutoff);
    const sessions = new Set<string>();
    for (const cp of corrPatterns) {
      if (cp.session) sessions.add(cp.session);
    }
    cluster.uniqueSessions = sessions.size;
  }

  // Convert chain sets to arrays
  const crossSessionChains: Record<string, CrossSessionChain> = {};
  for (const [key, data] of Object.entries(chainMap)) {
    if (data.sessions.size >= 2) { // Only count chains that appear across 2+ sessions
      crossSessionChains[key] = {
        occurrences: data.count,
        sessions: [...data.sessions],
      };
    }
  }

  state.toolStats = toolStats;
  state.correctionClusters = correctionClusters;
  state.crossSessionChains = crossSessionChains;
  saveState(state);

  return state;
}

// ─── Cross-Session Candidates ───────────────────────────────────────────

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

  // Tools used across many sessions with consistent patterns
  for (const [tool, stat] of Object.entries(state.toolStats)) {
    if (stat.uniqueSessions >= minSessions && stat.totalAcrossSessions >= 5) {
      candidates.push({
        tool,
        reason: "high_cross_session_usage",
        sessions: stat.uniqueSessions,
        occurrences: stat.totalAcrossSessions,
        detail: `${stat.totalAcrossSessions}x across ${stat.uniqueSessions} sessions (${Math.round(stat.successRate * 100)}% success)`,
      });
    }
  }

  // Corrections that span multiple sessions (systematic mistakes)
  for (const [tool, cluster] of Object.entries(state.correctionClusters)) {
    if (tool === "_unattributed") continue;
    if (cluster.uniqueSessions >= 2 && cluster.totalCorrections >= 3) {
      candidates.push({
        tool,
        reason: "cross_session_corrections",
        sessions: cluster.uniqueSessions,
        occurrences: cluster.totalCorrections,
        detail: `${cluster.totalCorrections} corrections across ${cluster.uniqueSessions} sessions: ${cluster.phrases.slice(0, 2).join("; ")}`,
      });
    }
  }

  // Chains that recur across sessions
  for (const [chain, data] of Object.entries(state.crossSessionChains)) {
    if (data.sessions.length >= minSessions) {
      candidates.push({
        tool: chain,
        reason: "cross_session_chain",
        sessions: data.sessions.length,
        occurrences: data.occurrences,
        detail: `Pipeline ${chain} used ${data.occurrences}x across ${data.sessions.length} sessions`,
      });
    }
  }

  // Sort by session breadth (more sessions = more important)
  candidates.sort((a, b) => b.sessions - a.sessions);
  return candidates;
}

// ─── Format for Display ─────────────────────────────────────────────────

export function formatCrossSessionReport(): string {
  const state = mergePatterns(); // Fresh merge
  const candidates = getCrossSessionCandidates();

  let text = `Cross-Session Pattern Report (${new Date(state.updated).toLocaleString()})\n\n`;

  // Top tools by cross-session usage
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

  // Cross-session corrections
  const corrections = Object.entries(state.correctionClusters)
    .filter(([t, c]) => t !== "_unattributed" && c.totalCorrections >= 2);
  if (corrections.length > 0) {
    text += `Recurring Corrections (cross-session):\n`;
    for (const [tool, cluster] of corrections) {
      text += `  ${tool}: ${cluster.totalCorrections} corrections — "${cluster.phrases[0] || ""}"\n`;
    }
    text += `\n`;
  }

  // Cross-session chains
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

  // Candidates
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
