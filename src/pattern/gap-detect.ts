/**
 * Gap Analysis Engine — AceForge v0.6.0
 * Identifies capability gaps from failure patterns, corrections, retry storms,
 * and chain breakages. Produces GapCandidates for remediation skill generation.
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");

interface PatternEntry {
  ts: string; tool: string; args_summary: string | null;
  result_summary?: string | null; success: boolean; session: string | null;
  type?: string; text_fragment?: string; error?: string | null;
  tools?: string[]; [key: string]: unknown;
}

export interface GapCandidate {
  tool: string;
  gapType: "high_failure" | "correction_cluster" | "retry_storm" | "chain_break";
  severity: number; evidence: string[]; suggestedFocus: string;
  failureTraces: PatternEntry[]; corrections: PatternEntry[];
}

function readPatternsFile(): PatternEntry[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];
  return content.trim().split("\n").filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) as PatternEntry; } catch { return null; } })
    .filter(Boolean) as PatternEntry[];
}

const GAP_BLOCKLIST = new Set([
  "forge", "forge_status", "forge_reflect", "forge_propose",
  "forge_approve_skill", "forge_reject_skill", "forge_quality",
  "forge_approve", "forge_reject", "forge_retire", "forge_reinstate",
  "forge_registry", "forge_rewards", "forge_gaps",
  "forge_retire_skill", "forge_tree", "forge_cross_session", "forge_compose",
  "forge_behavior_gaps", "forge_optimize",
  "forge_test", "forge_challenge", "forge_adversarial",
  "sessions_spawn", "sessions_list", "sessions_send", "sessions_history",
  "process", "message", "notify",
]);

export function detectGaps(externalPatterns?: PatternEntry[]): GapCandidate[] {
  const patterns = externalPatterns || readPatternsFile();
  if (patterns.length === 0) return [];
  const cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
  const recent = patterns.filter(p => new Date(p.ts).getTime() >= cutoff);
  const gaps: GapCandidate[] = [];
  const seen = new Set<string>();

  // Signal 1: High-failure tools
  const toolGroups = new Map<string, PatternEntry[]>();
  for (const p of recent) {
    if (p.type === "correction" || p.type === "chain") continue;
    if (!p.tool || GAP_BLOCKLIST.has(p.tool)) continue;
    if (!toolGroups.has(p.tool)) toolGroups.set(p.tool, []);
    toolGroups.get(p.tool)!.push(p);
  }
  for (const [tool, entries] of toolGroups) {
    if (entries.length < 5) continue;
    const failures = entries.filter(e => !e.success);
    const successRate = (entries.length - failures.length) / entries.length;
    if (successRate < 0.50) {
      const errorSummaries = failures.slice(0, 5)
        .map(f => f.error || f.result_summary || "unknown error")
        .map(e => typeof e === "string" ? e.slice(0, 80) : "unknown");
      gaps.push({
        tool, gapType: "high_failure", severity: 3 * failures.length,
        evidence: [`${Math.round(successRate * 100)}% success over ${entries.length} traces`, ...errorSummaries.map(e => `Error: ${e}`)],
        suggestedFocus: `Improve ${tool} reliability — ${failures.length} failures in ${entries.length} calls`,
        failureTraces: failures.slice(0, 10), corrections: [],
      });
      seen.add(tool);
    }
  }

  // Signal 2: Correction clusters
  const corrections = recent.filter(p => p.type === "correction");
  const correctionsByTool = new Map<string, PatternEntry[]>();
  for (const corr of corrections) {
    const corrTime = new Date(corr.ts).getTime();
    const sessionTools = recent
      .filter(p => p.session === corr.session && p.type !== "correction" && p.type !== "chain" && p.tool)
      .filter(p => new Date(p.ts).getTime() <= corrTime && corrTime - new Date(p.ts).getTime() < 120000)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    const associatedTool = sessionTools[0]?.tool;
    if (associatedTool && !GAP_BLOCKLIST.has(associatedTool)) {
      if (!correctionsByTool.has(associatedTool)) correctionsByTool.set(associatedTool, []);
      correctionsByTool.get(associatedTool)!.push(corr);
    }
  }
  for (const [tool, corrs] of correctionsByTool) {
    if (corrs.length < 2) continue;
    if (seen.has(tool)) {
      const existing = gaps.find(g => g.tool === tool);
      if (existing) { existing.severity += 4 * corrs.length; existing.corrections = corrs.slice(0, 5); existing.evidence.push(`${corrs.length} user corrections`); }
      continue;
    }
    const toolEntries = toolGroups.get(tool) || [];
    gaps.push({
      tool, gapType: "correction_cluster", severity: 4 * corrs.length,
      evidence: [`${corrs.length} corrections in last 28 days`, ...corrs.slice(0, 3).map(c => `User said: "${(c.text_fragment || "").slice(0, 60)}"`)],
      suggestedFocus: `Address recurring user corrections for ${tool}`,
      failureTraces: toolEntries.filter(e => !e.success).slice(0, 5), corrections: corrs.slice(0, 5),
    });
    seen.add(tool);
  }

  // Signal 3: Retry storms
  const sessionGroups = new Map<string, PatternEntry[]>();
  for (const p of recent) {
    if (p.type === "correction" || p.type === "chain" || !p.session) continue;
    if (!sessionGroups.has(p.session)) sessionGroups.set(p.session, []);
    sessionGroups.get(p.session)!.push(p);
  }
  const retryStorms = new Map<string, number>();
  for (const [, entries] of sessionGroups) {
    entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    for (let i = 0; i < entries.length; i++) {
      const tool = entries[i].tool;
      if (!tool || GAP_BLOCKLIST.has(tool)) continue;
      const baseArgs = (entries[i].args_summary || "").slice(0, 80);
      let consecutive = 1;
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[j].tool !== tool) break;
        if (new Date(entries[j].ts).getTime() - new Date(entries[i].ts).getTime() > 120000) break;
        const nextArgs = (entries[j].args_summary || "").slice(0, 80);
        if (baseArgs && nextArgs && baseArgs !== nextArgs) break;
        consecutive++;
      }
      if (consecutive >= 3) retryStorms.set(tool, (retryStorms.get(tool) || 0) + 1);
    }
  }
  for (const [tool, count] of retryStorms) {
    if (seen.has(tool)) { const existing = gaps.find(g => g.tool === tool); if (existing) { existing.severity += 2 * count; existing.evidence.push(`${count} retry storms`); } continue; }
    if (count < 2) continue;
    const toolEntries = toolGroups.get(tool) || [];
    gaps.push({
      tool, gapType: "retry_storm", severity: 2 * count,
      evidence: [`${count} retry storms — agent called ${tool} 3+ times rapidly`],
      suggestedFocus: `Reduce retry failures for ${tool}`,
      failureTraces: toolEntries.filter(e => !e.success).slice(0, 5), corrections: [],
    });
    seen.add(tool);
  }

  // Signal 4: Chain breakages
  const chains = recent.filter(p => p.type === "chain" && p.tools && Array.isArray(p.tools));
  const chainToolFailures = new Map<string, number>();
  for (const chain of chains) {
    const tools = chain.tools as string[];
    const lastTool = tools[tools.length - 1];
    if (lastTool && !GAP_BLOCKLIST.has(lastTool)) {
      const toolEntries = toolGroups.get(lastTool) || [];
      if (toolEntries.filter(e => !e.success).length > 0) {
        chainToolFailures.set(lastTool, (chainToolFailures.get(lastTool) || 0) + 1);
      }
    }
  }
  for (const [tool, count] of chainToolFailures) {
    if (seen.has(tool) || count < 2) continue;
    const toolEntries = toolGroups.get(tool) || [];
    gaps.push({
      tool, gapType: "chain_break", severity: 3 * count,
      evidence: [`Fails as chain endpoint in ${count} workflow sequences`],
      suggestedFocus: `${tool} reliability when used at end of multi-tool workflows`,
      failureTraces: toolEntries.filter(e => !e.success).slice(0, 5), corrections: [],
    });
    seen.add(tool);
  }

  gaps.sort((a, b) => b.severity - a.severity);
  return gaps;
}
