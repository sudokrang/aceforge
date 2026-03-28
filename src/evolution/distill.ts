/**
 * Trace Distillation Engine — v0.9.0
 *
 * Milestone-based distillation following K2-Agent's Summarize–Reflect–Locate–Revise
 * (SRLR) loop (arXiv:2603.00676). At activation milestones (500/2000/5000), diffs
 * post-deploy trace data against the original generation traces and surfaces
 * meaningful delta for human-guided evolution.
 *
 * Does NOT auto-mutate skills. Surfaces deltas via notification and queues
 * evolution proposals for `/forge evolve` approval.
 *
 * Research basis:
 *  - K2-Agent SRLR (arXiv:2603.00676): Summarize–Reflect–Locate–Revise for knowledge refinement
 *  - SAGE (arXiv:2512.17102): Milestone-based skill accumulation via Sequential Rollout
 *  - SDFT (arXiv:2601.19897): Preserve prior capabilities while acquiring new signals
 *  - SE-Agent (arXiv:2508.02085): Trajectory-level revision outperforms full regeneration
 */

import * as fsSync from "fs";
import * as path from "path";
import { FORGE_DIR, SKILLS_DIR, PatternEntry } from "../pattern/constants.js";

// ─── Milestone Configuration ────────────────────────────────────────────

/**
 * Activation milestones that trigger distillation.
 * 500:  Early operational review — enough data to see emergent patterns
 * 2000: Mid-lifecycle review — skill well-exercised, patterns stabilized
 * 5000: Maturity review — comprehensive delta, deep refinement opportunity
 */
export const DISTILL_MILESTONES = [500, 2000, 5000] as const;

/** Minimum percentage of new arg patterns to consider delta meaningful */
const MEANINGFUL_ARG_DELTA_PCT = 0.10;

/** Minimum new failure patterns to flag */
const MEANINGFUL_FAILURE_COUNT = 3;

/** Minimum new correction count to flag */
const MEANINGFUL_CORRECTION_COUNT = 2;

// ─── Types ──────────────────────────────────────────────────────────────

export interface DistillationReport {
  skill: string;
  milestone: number;
  totalActivations: number;
  tracesAtDeploy: number;
  tracesNow: number;
  newTraceCount: number;

  /** SRLR Phase 1: Summarize — what patterns exist now */
  summary: {
    topArgPatterns: Array<{ pattern: string; count: number; successRate: number }>;
    overallSuccessRate: number;
    distinctSessions: number;
    timeSpanDays: number;
  };

  /** SRLR Phase 2: Reflect — what changed since deployment */
  reflection: {
    newArgPatterns: Array<{ pattern: string; count: number; successRate: number }>;
    newFailurePatterns: Array<{ pattern: string; count: number; error: string }>;
    newCorrections: Array<{ text: string; ts: string }>;
    successRateDelta: number; // positive = improved
  };

  /** SRLR Phase 3: Locate — where the skill diverges from current usage */
  divergences: Array<{
    type: "uncovered_args" | "new_failure_mode" | "correction_gap" | "success_improvement";
    description: string;
    severity: "high" | "medium" | "low";
    evidence: string[];
  }>;

  /** SRLR Phase 4: Revise — recommended actions */
  recommendations: string[];

  /** Whether delta is meaningful enough to warrant evolution */
  meaningful: boolean;
}

export interface MilestoneCheck {
  hit: boolean;
  milestone: number | null;
  alreadyDistilled: boolean;
}

// ─── Milestone Detection ────────────────────────────────────────────────

/**
 * Checks if a skill has hit a distillation milestone.
 * Reads skill-health.jsonl to determine if this milestone was already processed.
 */

// In-memory cache: once a milestone is distilled, skip file I/O on subsequent calls
const _milestoneCache = new Map<string, boolean>();

export function checkMilestone(skillName: string, activationCount: number): MilestoneCheck {
  // Find the highest milestone <= activationCount
  let hitMilestone: number | null = null;
  for (const ms of DISTILL_MILESTONES) {
    if (activationCount >= ms) hitMilestone = ms;
  }

  if (!hitMilestone) return { hit: false, milestone: null, alreadyDistilled: false };

  // Fast path: cached milestone = skip 2600+ line file read
  const cacheKey = `${skillName}:${hitMilestone}`;
  if (_milestoneCache.get(cacheKey)) {
    return { hit: true, milestone: hitMilestone, alreadyDistilled: true };
  }

  // Check if we already distilled at this milestone
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  if (fsSync.existsSync(healthFile)) {
    const content = fsSync.readFileSync(healthFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (
          entry.skill === skillName &&
          entry.action === "distillation_complete" &&
          entry.milestone === hitMilestone
        ) {
          { _milestoneCache.set(`${skillName}:${hitMilestone}`, true); return { hit: true, milestone: hitMilestone, alreadyDistilled: true }; }
        }
      } catch { /* skip malformed lines */ }
    }
  }

  return { hit: true, milestone: hitMilestone, alreadyDistilled: false };
}

// ─── Trace Loading ──────────────────────────────────────────────────────

interface TraceSlice {
  entries: PatternEntry[];
  corrections: PatternEntry[];
  sessions: Set<string>;
  firstTs: string;
  lastTs: string;
}

/**
 * Loads traces for a tool from patterns.jsonl, optionally filtered by timestamp.
 */
function loadTraces(toolName: string, afterTs?: string): TraceSlice {
  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(patternsFile)) {
    return { entries: [], corrections: [], sessions: new Set(), firstTs: "", lastTs: "" };
  }

  const content = fsSync.readFileSync(patternsFile, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  const entries: PatternEntry[] = [];
  const corrections: PatternEntry[] = [];
  const sessions = new Set<string>();

  const afterTime = afterTs ? new Date(afterTs).getTime() : 0;

  for (const line of lines) {
    try {
      const e = JSON.parse(line) as PatternEntry;
      if (afterTs && new Date(e.ts).getTime() <= afterTime) continue;

      if (e.type === "correction") {
        corrections.push(e);
      } else if (e.tool === toolName && e.type !== "chain") {
        entries.push(e);
        if (e.session) sessions.add(e.session);
      }
    } catch { /* skip */ }
  }

  return {
    entries,
    corrections,
    sessions,
    firstTs: entries.length > 0 ? entries[0].ts : "",
    lastTs: entries.length > 0 ? entries[entries.length - 1].ts : "",
  };
}

/**
 * Resolves the primary tool name for a deployed skill by reading
 * the deployment baseline or frontmatter.
 */
function resolveToolName(skillName: string): string | null {
  // Check deployment baseline first
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  if (fsSync.existsSync(healthFile)) {
    const lines = fsSync.readFileSync(healthFile, "utf-8").split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.skill === skillName && entry.action === "deployment_baseline" && entry.tool) {
          return entry.tool;
        }
      } catch { /* skip */ }
    }
  }

  // Fallback: read frontmatter
  const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
  if (fsSync.existsSync(skillFile)) {
    const content = fsSync.readFileSync(skillFile, "utf-8");
    const toolMatch = content.match(/^\s*tool:\s*(.+)$/m);
    if (toolMatch) return toolMatch[1].trim();
  }

  // Last resort: strip common suffixes from skill name
  return skillName.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow)$/, "");
}

// ─── Arg Pattern Extraction ─────────────────────────────────────────────

interface ArgPattern {
  pattern: string;
  count: number;
  successRate: number;
  examples: string[];
}

/**
 * Clusters arg_summary values into patterns by extracting the structural
 * prefix (first 60 chars, normalized). Groups by prefix and computes stats.
 */
function extractArgPatterns(entries: PatternEntry[]): ArgPattern[] {
  const groups = new Map<string, { total: number; success: number; examples: string[] }>();

  for (const e of entries) {
    const raw = e.args_summary || "(no args)";
    // Normalize: strip variable parts like IDs, timestamps, paths
    const normalized = raw
      .replace(/[0-9a-f]{8,}/gi, "<id>")       // hex IDs
      .replace(/\d{4}-\d{2}-\d{2}/g, "<date>") // ISO dates
      .replace(/\/[^\s"',}]{10,}/g, "<path>")   // long paths
      .replace(/\d{5,}/g, "<num>")              // large numbers
      .slice(0, 80);

    const group = groups.get(normalized) || { total: 0, success: 0, examples: [] };
    group.total++;
    if (e.success) group.success++;
    if (group.examples.length < 3) group.examples.push(raw.slice(0, 100));
    groups.set(normalized, group);
  }

  return Array.from(groups.entries())
    .map(([pattern, g]) => ({
      pattern,
      count: g.total,
      successRate: g.total > 0 ? Math.round((g.success / g.total) * 100) / 100 : 0,
      examples: g.examples,
    }))
    .sort((a, b) => b.count - a.count);
}

// ─── Failure Pattern Extraction ─────────────────────────────────────────

interface FailurePattern {
  pattern: string;
  count: number;
  error: string;
}

function extractFailurePatterns(entries: PatternEntry[]): FailurePattern[] {
  const failures = entries.filter(e => !e.success);
  const groups = new Map<string, { count: number; error: string }>();

  for (const f of failures) {
    const errorKey = (f.error || "unknown")
      .replace(/[0-9a-f]{8,}/gi, "<id>")
      .replace(/\/[^\s"',}]{10,}/g, "<path>")
      .slice(0, 120);

    const group = groups.get(errorKey) || { count: 0, error: errorKey };
    group.count++;
    groups.set(errorKey, group);
  }

  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count);
}

// ─── SRLR Distillation ─────────────────────────────────────────────────

/**
 * Performs the full SRLR distillation for a deployed skill.
 *
 * Phase 1 — Summarize: aggregate current trace data into patterns
 * Phase 2 — Reflect: diff against generation-time traces
 * Phase 3 — Locate: identify divergences between skill and usage
 * Phase 4 — Revise: produce actionable recommendations
 */
export function distillNewTraces(skillName: string, milestone: number): DistillationReport | null {
  const toolName = resolveToolName(skillName);
  if (!toolName) return null;

  // Find deployment baseline
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  if (!fsSync.existsSync(healthFile)) return null;

  let deployTs: string | null = null;
  let tracesAtDeploy = 0;
  let baselineSuccessRate = 0;

  const healthLines = fsSync.readFileSync(healthFile, "utf-8").split("\n").filter(l => l.trim());
  for (const line of healthLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.skill === skillName && entry.action === "deployment_baseline") {
        deployTs = entry.ts;
        tracesAtDeploy = entry.traceCountAtDeploy || 0;
        baselineSuccessRate = entry.baselineSuccessRate || 0;
        break;
      }
    } catch { /* skip */ }
  }

  if (!deployTs) return null;

  // Count activations
  let totalActivations = 0;
  for (const line of healthLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.skill === skillName && entry.action === "activation") totalActivations++;
    } catch { /* skip */ }
  }

  // Load traces ONCE, split in memory (perf fix: was 3 file reads)
  const allTraces = loadTraces(toolName);
  const deployTime = new Date(deployTs).getTime();
  const newTraceEntries = allTraces.entries.filter(e => new Date(e.ts).getTime() > deployTime);
  const newTraceCorrections = allTraces.corrections.filter(c => new Date(c.ts).getTime() > deployTime);
  const newTraceSessions = new Set(newTraceEntries.filter(e => e.session).map(e => e.session!));

  if (newTraceEntries.length === 0) return null;

  // ═══ Phase 1: Summarize ═══════════════════════════════════════════════

  const allArgPatterns = extractArgPatterns(allTraces.entries);
  const overallSuccessRate = allTraces.entries.length > 0
    ? Math.round(
        (allTraces.entries.filter(e => e.success).length / allTraces.entries.length) * 100
      ) / 100
    : 0;

  const firstTs = allTraces.entries[0]?.ts || "";
  const lastTs = allTraces.entries[allTraces.entries.length - 1]?.ts || "";
  const timeSpanDays = firstTs && lastTs
    ? Math.max(1, Math.round((new Date(lastTs).getTime() - new Date(firstTs).getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  const summary = {
    topArgPatterns: allArgPatterns.slice(0, 10),
    overallSuccessRate,
    distinctSessions: allTraces.sessions.size,
    timeSpanDays,
  };

  // ═══ Phase 2: Reflect ═════════════════════════════════════════════════

  const preDeployTraces = loadTraces(toolName);
  const preDeployPatterns = new Set(
    preDeployTraces.entries
      .filter(e => new Date(e.ts).getTime() <= new Date(deployTs!).getTime())
      .map(e => (e.args_summary || "(no args)")
        .replace(/[0-9a-f]{8,}/gi, "<id>")
        .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
        .replace(/\/[^\s"',}]{10,}/g, "<path>")
        .replace(/\d{5,}/g, "<num>")
        .slice(0, 80)
      )
  );

  const newArgPatterns = extractArgPatterns(newTraceEntries)
    .filter(p => !preDeployPatterns.has(p.pattern));

  const preDeployFailures = new Set(
    extractFailurePatterns(
      allTraces.entries.filter(e => new Date(e.ts).getTime() <= deployTime)
    ).map(f => f.error)
  );

  const newFailurePatterns = extractFailurePatterns(newTraceEntries)
    .filter(f => !preDeployFailures.has(f.error));

  // Corrections since deployment
  const newCorrections = newTraceCorrections
    .filter(c => c.text_fragment)
    .map(c => ({ text: c.text_fragment!, ts: c.ts }));

  const postDeploySuccessRate = newTraceEntries.length > 0
    ? (newTraceEntries.filter(e => e.success).length / newTraceEntries.length)
    : 0;
  const successRateDelta = Math.round((postDeploySuccessRate - baselineSuccessRate) * 100);

  const reflection = {
    newArgPatterns,
    newFailurePatterns,
    newCorrections,
    successRateDelta,
  };

  // ═══ Phase 3: Locate Divergences ══════════════════════════════════════

  const divergences: DistillationReport["divergences"] = [];

  // Uncovered argument patterns
  const argDeltaPct = allArgPatterns.length > 0
    ? newArgPatterns.length / allArgPatterns.length
    : 0;

  if (newArgPatterns.length > 0 && argDeltaPct >= MEANINGFUL_ARG_DELTA_PCT) {
    divergences.push({
      type: "uncovered_args",
      description: `${newArgPatterns.length} new argument patterns emerged since deployment`,
      severity: argDeltaPct > 0.3 ? "high" : argDeltaPct > 0.15 ? "medium" : "low",
      evidence: newArgPatterns.slice(0, 5).map(
        p => `"${p.pattern}" (${p.count}x, ${Math.round(p.successRate * 100)}% success)`
      ),
    });
  }

  // New failure modes
  if (newFailurePatterns.length >= MEANINGFUL_FAILURE_COUNT) {
    const totalNewFailures = newFailurePatterns.reduce((s, f) => s + f.count, 0);
    divergences.push({
      type: "new_failure_mode",
      description: `${newFailurePatterns.length} new failure modes detected (${totalNewFailures} total failures)`,
      severity: totalNewFailures > 20 ? "high" : totalNewFailures > 8 ? "medium" : "low",
      evidence: newFailurePatterns.slice(0, 5).map(
        f => `"${f.error}" (${f.count}x)`
      ),
    });
  }

  // Correction gaps
  if (newCorrections.length >= MEANINGFUL_CORRECTION_COUNT) {
    divergences.push({
      type: "correction_gap",
      description: `${newCorrections.length} user corrections since deployment`,
      severity: newCorrections.length > 5 ? "high" : "medium",
      evidence: newCorrections.slice(0, 3).map(c => `"${c.text.slice(0, 80)}"`),
    });
  }

  // Success improvement
  if (successRateDelta > 10) {
    divergences.push({
      type: "success_improvement",
      description: `Success rate improved +${successRateDelta}pp since deployment`,
      severity: "low",
      evidence: [`Baseline: ${Math.round(baselineSuccessRate * 100)}% → Current: ${Math.round(postDeploySuccessRate * 100)}%`],
    });
  }

  // ═══ Phase 4: Revise Recommendations ══════════════════════════════════

  const recommendations: string[] = [];

  if (divergences.some(d => d.type === "uncovered_args" && d.severity !== "low")) {
    recommendations.push(
      "Run `/forge evolve " + skillName + "` to incorporate new argument patterns into skill instructions"
    );
  }

  if (divergences.some(d => d.type === "new_failure_mode")) {
    recommendations.push(
      "New failure modes should be added to the Error Recovery section — evolve will include them"
    );
  }

  if (divergences.some(d => d.type === "correction_gap")) {
    recommendations.push(
      "User corrections indicate the skill's Anti-Patterns section needs updating"
    );
  }

  if (divergences.length === 0) {
    recommendations.push(
      "No meaningful divergence detected — skill is well-aligned with current usage"
    );
  }

  // Meaningful = at least one non-low divergence
  const meaningful = divergences.some(d => d.severity !== "low");

  return {
    skill: skillName,
    milestone,
    totalActivations,
    tracesAtDeploy,
    tracesNow: allTraces.entries.length,
    newTraceCount: newTraceEntries.length,
    summary,
    reflection,
    divergences,
    recommendations,
    meaningful,
  };
}

// ─── Record distillation completion ─────────────────────────────────────

export function recordDistillation(skillName: string, milestone: number, meaningful: boolean): void {
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    skill: skillName,
    action: "distillation_complete",
    milestone,
    meaningful,
  }) + "\n";
  fsSync.appendFileSync(healthFile, entry);
  // Populate cache so subsequent activations skip file I/O
  _milestoneCache.set(`${skillName}:${milestone}`, true);
}

// ─── Format distillation report for notification ────────────────────────

export function formatDistillationNotification(report: DistillationReport): string {
  const lines: string[] = [];

  lines.push(`Trace Distillation Report — ${report.skill}`);
  lines.push(`Milestone: ${report.milestone} activations`);
  lines.push(``);
  lines.push(`Traces: ${report.tracesAtDeploy} at deploy → ${report.tracesNow} now (+${report.newTraceCount})`);
  lines.push(`Success: ${Math.round(report.summary.overallSuccessRate * 100)}% (${report.reflection.successRateDelta >= 0 ? "+" : ""}${report.reflection.successRateDelta}pp vs baseline)`);
  lines.push(`Sessions: ${report.summary.distinctSessions} across ${report.summary.timeSpanDays} days`);

  if (report.divergences.length > 0) {
    lines.push(``);
    lines.push(`Divergences:`);
    for (const d of report.divergences) {
      const icon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "🟢";
      lines.push(`  ${icon} ${d.description}`);
      if (d.evidence.length > 0) {
        lines.push(`     ${d.evidence[0]}`);
      }
    }
  }

  if (report.recommendations.length > 0) {
    lines.push(``);
    for (const r of report.recommendations) {
      lines.push(`→ ${r}`);
    }
  }

  return lines.join("\n");
}

// ─── Format full distillation report for /forge distill command ─────────

export function formatDistillationReport(report: DistillationReport): string {
  const lines: string[] = [];

  lines.push(`══ Trace Distillation: ${report.skill} ══`);
  lines.push(`Milestone: ${report.milestone} activations (${report.totalActivations} total)`);
  lines.push(``);

  // Summary
  lines.push(`── Summary (current state) ──`);
  lines.push(`  Traces: ${report.tracesNow} total, ${report.newTraceCount} since deploy`);
  lines.push(`  Success rate: ${Math.round(report.summary.overallSuccessRate * 100)}%`);
  lines.push(`  Sessions: ${report.summary.distinctSessions} across ${report.summary.timeSpanDays} days`);
  lines.push(`  Top patterns:`);
  for (const p of report.summary.topArgPatterns.slice(0, 5)) {
    lines.push(`    ${p.pattern} (${p.count}x, ${Math.round(p.successRate * 100)}%)`);
  }

  // Reflection
  lines.push(``);
  lines.push(`── Reflection (what changed) ──`);
  lines.push(`  Success delta: ${report.reflection.successRateDelta >= 0 ? "+" : ""}${report.reflection.successRateDelta}pp vs baseline`);
  lines.push(`  New arg patterns: ${report.reflection.newArgPatterns.length}`);
  if (report.reflection.newArgPatterns.length > 0) {
    for (const p of report.reflection.newArgPatterns.slice(0, 3)) {
      lines.push(`    → "${p.pattern}" (${p.count}x)`);
    }
  }
  lines.push(`  New failure modes: ${report.reflection.newFailurePatterns.length}`);
  if (report.reflection.newFailurePatterns.length > 0) {
    for (const f of report.reflection.newFailurePatterns.slice(0, 3)) {
      lines.push(`    → "${f.error}" (${f.count}x)`);
    }
  }
  lines.push(`  Corrections: ${report.reflection.newCorrections.length}`);

  // Divergences
  if (report.divergences.length > 0) {
    lines.push(``);
    lines.push(`── Divergences ──`);
    for (const d of report.divergences) {
      const icon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "🟢";
      lines.push(`  ${icon} [${d.severity.toUpperCase()}] ${d.description}`);
      for (const ev of d.evidence.slice(0, 3)) {
        lines.push(`     ${ev}`);
      }
    }
  }

  // Recommendations
  lines.push(``);
  lines.push(`── Recommendations ──`);
  for (const r of report.recommendations) {
    lines.push(`  → ${r}`);
  }

  return lines.join("\n");
}
