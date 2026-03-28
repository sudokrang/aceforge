/**
 * Evolve Command Handler — v0.9.0
 *
 * `/forge evolve <skill>` triggers a human-approved skill revision cycle:
 * 1. Runs trace distillation to compute delta
 * 2. Sends current skill + delta to LLM for revision
 * 3. Generates unified diff between current and proposed
 * 4. Queues as a proposal requiring `/forge approve` to deploy
 *
 * Design constraints (from spec):
 *  - No auto-mutation: always requires human approval
 *  - Unified diff for transparency: human sees exactly what changes
 *  - Preserves existing wisdom: revision, not regeneration (SE-Agent, arXiv:2508.02085)
 *
 * Research basis:
 *  - SE-Agent (arXiv:2508.02085): Trajectory-level revision outperforms regeneration
 *  - SDFT (arXiv:2601.19897): On-policy distillation preserves prior capabilities
 *  - K2-Agent SRLR (arXiv:2603.00676): Locate-Revise phase for targeted updates
 *  - Voyager (arXiv:2305.16291): Self-verification before committing to library
 */

import * as fsSync from "fs";
import * as path from "path";
import { FORGE_DIR, SKILLS_DIR, PatternEntry } from "../pattern/constants.js";
import { distillNewTraces, type DistillationReport } from "./distill.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface EvolveResult {
  success: boolean;
  error?: string;
  proposalName?: string;
  diff?: string;
  distillation?: DistillationReport;
  summary?: string;
}

export interface DiffLine {
  type: "context" | "addition" | "deletion";
  content: string;
  lineNum: { old: number | null; new: number | null };
}

// ─── Unified Diff Generation ────────────────────────────────────────────

/**
 * Generates a unified diff between two text files.
 * Custom implementation — no external dependencies.
 *
 * Uses a simple LCS-based approach for line-level diffing,
 * with 3 lines of context around each change hunk.
 */
export function generateUnifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  contextLines: number = 3,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // LCS table for line-level diff
  const lcs = computeLCS(oldLines, newLines);
  const editScript = buildEditScript(oldLines, newLines, lcs);

  // Group edits into hunks with context
  const hunks = buildHunks(editScript, oldLines, newLines, contextLines);

  if (hunks.length === 0) return ""; // No differences

  const lines: string[] = [];
  lines.push(`--- ${oldLabel}`);
  lines.push(`+++ ${newLabel}`);

  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`
    );
    for (const line of hunk.lines) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

interface Edit {
  type: "keep" | "insert" | "delete";
  oldIdx: number;
  newIdx: number;
  text: string;
}

function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;

  // Use rolling array to save memory on large files
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

function buildEditScript(a: string[], b: string[], dp: number[][]): Edit[] {
  const edits: Edit[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      edits.unshift({ type: "keep", oldIdx: i - 1, newIdx: j - 1, text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.unshift({ type: "insert", oldIdx: i - 1, newIdx: j - 1, text: b[j - 1] });
      j--;
    } else if (i > 0) {
      edits.unshift({ type: "delete", oldIdx: i - 1, newIdx: j - 1, text: a[i - 1] });
      i--;
    }
  }

  return edits;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function buildHunks(edits: Edit[], oldLines: string[], newLines: string[], ctx: number): Hunk[] {
  // Find change ranges
  const changeIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== "keep") changeIndices.push(i);
  }

  if (changeIndices.length === 0) return [];

  // Group changes into hunks (merge if context lines overlap)
  const groups: Array<{ start: number; end: number }> = [];
  let currentGroup = { start: changeIndices[0], end: changeIndices[0] };

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - currentGroup.end <= ctx * 2 + 1) {
      currentGroup.end = changeIndices[i];
    } else {
      groups.push({ ...currentGroup });
      currentGroup = { start: changeIndices[i], end: changeIndices[i] };
    }
  }
  groups.push(currentGroup);

  // Build hunk output
  const hunks: Hunk[] = [];

  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - ctx);
    const hunkEnd = Math.min(edits.length - 1, group.end + ctx);

    const lines: string[] = [];
    let oldStart = -1;
    let newStart = -1;
    let oldCount = 0;
    let newCount = 0;

    for (let i = hunkStart; i <= hunkEnd; i++) {
      const edit = edits[i];

      if (edit.type === "keep") {
        if (oldStart === -1) {
          oldStart = edit.oldIdx;
          newStart = edit.newIdx;
        }
        lines.push(` ${edit.text}`);
        oldCount++;
        newCount++;
      } else if (edit.type === "delete") {
        if (oldStart === -1) {
          oldStart = edit.oldIdx;
          newStart = edit.newIdx + 1;
        }
        lines.push(`-${edit.text}`);
        oldCount++;
      } else if (edit.type === "insert") {
        if (oldStart === -1) {
          oldStart = edit.oldIdx + 1;
          newStart = edit.newIdx;
        }
        lines.push(`+${edit.text}`);
        newCount++;
      }
    }

    if (oldStart === -1) oldStart = 0;
    if (newStart === -1) newStart = 0;

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}

// ─── Evolution Prompt Builder ───────────────────────────────────────────

/**
 * Builds the LLM prompt for skill evolution.
 * Follows SE-Agent's trajectory-level revision approach:
 * provide the delta, not the full trace corpus.
 */
function buildEvolutionPrompt(
  currentSkillMd: string,
  report: DistillationReport,
  recentTraces: PatternEntry[],
): string {
  const parts: string[] = [];

  parts.push(`You are revising an existing SKILL.md file based on new operational data.`);
  parts.push(`Your goal is to UPDATE the skill — preserve what works, add what's new, fix what's broken.`);
  parts.push(`Do NOT regenerate from scratch. This is a targeted revision.`);
  parts.push(``);
  parts.push(`═══ CURRENT SKILL.md ═══`);
  parts.push(currentSkillMd);
  parts.push(``);
  parts.push(`═══ DISTILLATION DELTA ═══`);
  parts.push(`Milestone: ${report.milestone} activations`);
  parts.push(`Success rate: ${Math.round(report.summary.overallSuccessRate * 100)}% (${report.reflection.successRateDelta >= 0 ? "+" : ""}${report.reflection.successRateDelta}pp vs baseline)`);
  parts.push(``);

  if (report.reflection.newArgPatterns.length > 0) {
    parts.push(`NEW ARGUMENT PATTERNS (not covered by current skill):`);
    for (const p of report.reflection.newArgPatterns.slice(0, 8)) {
      parts.push(`  - "${p.pattern}" (${p.count}x, ${Math.round(p.successRate * 100)}% success)`);
    }
    parts.push(``);
  }

  if (report.reflection.newFailurePatterns.length > 0) {
    parts.push(`NEW FAILURE MODES:`);
    for (const f of report.reflection.newFailurePatterns.slice(0, 5)) {
      parts.push(`  - "${f.error}" (${f.count}x)`);
    }
    parts.push(``);
  }

  if (report.reflection.newCorrections.length > 0) {
    parts.push(`USER CORRECTIONS SINCE DEPLOYMENT:`);
    for (const c of report.reflection.newCorrections.slice(0, 5)) {
      parts.push(`  - "${c.text.slice(0, 120)}"`);
    }
    parts.push(``);
  }

  if (report.divergences.length > 0) {
    parts.push(`DIVERGENCES DETECTED:`);
    for (const d of report.divergences) {
      parts.push(`  [${d.severity.toUpperCase()}] ${d.description}`);
    }
    parts.push(``);
  }

  // Sample traces
  if (recentTraces.length > 0) {
    parts.push(`SAMPLE RECENT TRACES (${Math.min(recentTraces.length, 15)} of ${recentTraces.length}):`);
    for (const t of recentTraces.slice(0, 15)) {
      const status = t.success ? "OK" : "FAIL";
      parts.push(`  [${status}] args: ${t.args_summary || "(none)"}`);
      if (!t.success && t.error) parts.push(`         error: ${t.error.slice(0, 100)}`);
    }
    parts.push(``);
  }

  parts.push(`═══ INSTRUCTIONS ═══`);
  parts.push(`1. Preserve ALL existing sections that still apply`);
  parts.push(`2. Add new argument patterns to the Instructions section`);
  parts.push(`3. Add new failure modes to the Error Recovery section`);
  parts.push(`4. Add user corrections as Anti-Patterns or instruction notes`);
  parts.push(`5. Update the description ONLY if the tool's usage has meaningfully broadened`);
  parts.push(`6. Keep YAML frontmatter intact — only update version, description if needed`);
  parts.push(`7. Maintain the same section structure: When to Use → Pre-flight → Instructions → Error Recovery → Anti-Patterns`);
  parts.push(`8. Output ONLY the complete revised SKILL.md — no commentary, no markdown fences`);

  return parts.join("\n");
}

// ─── Evolve Execution ───────────────────────────────────────────────────

/**
 * Executes the full evolution cycle for a deployed skill:
 * 1. Validates the skill exists and is deployed
 * 2. Runs trace distillation
 * 3. Sends to LLM for revision (if LLM is available)
 * 4. Generates unified diff
 * 5. Writes proposal for human approval
 *
 * Returns the result with diff for display.
 */
export async function executeEvolve(
  skillName: string,
  reviseWithLlm?: (prompt: string) => Promise<string | null>,
): Promise<EvolveResult> {
  // 1. Validate skill exists
  const skillDir = path.join(SKILLS_DIR, skillName);
  if (!fsSync.existsSync(skillDir)) {
    return { success: false, error: `Skill '${skillName}' not found in deployed skills.` };
  }

  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fsSync.existsSync(skillFile)) {
    return { success: false, error: `Skill '${skillName}' has no SKILL.md.` };
  }

  // Guard: check for any existing evolution/upgrade proposal for this skill
  // Prevents duplicate proposals from analyze.ts Path 1 and /forge evolve racing
  const proposalsDir = path.join(FORGE_DIR, "proposals");
  if (fsSync.existsSync(proposalsDir)) {
    for (const existing of fsSync.readdirSync(proposalsDir)) {
      if (existing.startsWith(skillName + "-") || existing.startsWith(skillName.replace(/-(v\d+|rev\d+|upgrade|evolved)$/, "") + "-")) {
        return { success: false, error: `Proposal '${existing}' already pending for this skill. Approve or reject it first.` };
      }
    }
  }

  const currentMd = fsSync.readFileSync(skillFile, "utf-8");

  // 2. Run distillation — find the best milestone
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  let activationCount = 0;
  if (fsSync.existsSync(healthFile)) {
    const lines = fsSync.readFileSync(healthFile, "utf-8").split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.skill === skillName && entry.action === "activation") activationCount++;
      } catch { /* skip */ }
    }
  }

  // Use activation count as milestone, or minimum of 50 for manual evolve
  const effectiveMilestone = Math.max(50, activationCount);
  const report = distillNewTraces(skillName, effectiveMilestone);

  if (!report) {
    return {
      success: false,
      error: `No trace data available for '${skillName}'. Ensure the skill has been deployed and activated.`,
    };
  }

  // 3. Load recent traces for context
  const toolName = resolveToolForEvolve(skillName);
  const recentTraces = loadRecentTraces(toolName, 50);

  // 4. Build evolution prompt
  const prompt = buildEvolutionPrompt(currentMd, report, recentTraces);

  // 5. Attempt LLM revision
  let revisedMd: string | null = null;

  if (reviseWithLlm) {
    try {
      revisedMd = await reviseWithLlm(prompt);
    } catch (err) {
      console.error(`[aceforge] evolve LLM error: ${(err as Error).message}`);
    }
  }

  if (!revisedMd) {
    // No LLM available — return distillation report only
    return {
      success: true,
      distillation: report,
      summary: "Distillation complete but LLM unavailable for revision. Review the report and edit manually.",
    };
  }

  // 6. Clean up LLM output
  revisedMd = cleanLlmOutput(revisedMd);

  // 7. Generate diff
  const diff = generateUnifiedDiff(
    currentMd,
    revisedMd,
    `a/${skillName}/SKILL.md`,
    `b/${skillName}/SKILL.md`,
  );

  if (!diff) {
    return {
      success: true,
      distillation: report,
      summary: "LLM revision produced no changes — skill is already aligned with current usage.",
    };
  }

  // 8. Write proposal
  const proposalName = `${skillName}-evolved`;
  const proposalDir = path.join(FORGE_DIR, "proposals", proposalName);
  fsSync.mkdirSync(proposalDir, { recursive: true });
  fsSync.writeFileSync(path.join(proposalDir, "SKILL.md"), revisedMd);

  // Write diff file for reference
  fsSync.writeFileSync(path.join(proposalDir, "DIFF.patch"), diff);

  // Write distillation report
  fsSync.writeFileSync(
    path.join(proposalDir, "distillation.json"),
    JSON.stringify(report, null, 2),
  );

  // Log evolution candidate
  const candidatesFile = path.join(FORGE_DIR, "candidates.jsonl");
  const candidateEntry = {
    ts: new Date().toISOString(),
    tool: toolName,
    type: "evolution_v2",
    replaces: skillName,
    milestone: report.milestone,
    divergenceCount: report.divergences.length,
    meaningful: report.meaningful,
  };
  fsSync.appendFileSync(candidatesFile, JSON.stringify(candidateEntry) + "\n");

  return {
    success: true,
    proposalName,
    diff,
    distillation: report,
    summary: `Evolution proposal '${proposalName}' created with ${report.divergences.length} divergence(s). Use /forge approve ${proposalName} to deploy.`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function resolveToolForEvolve(skillName: string): string {
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
  return skillName.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow)$/, "");
}

function loadRecentTraces(toolName: string, limit: number): PatternEntry[] {
  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(patternsFile)) return [];

  const content = fsSync.readFileSync(patternsFile, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  const entries: PatternEntry[] = [];

  // Read from end for most recent
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]) as PatternEntry;
      if (e.tool === toolName && e.type !== "chain" && e.type !== "correction") {
        entries.push(e);
      }
    } catch { /* skip */ }
  }

  return entries.reverse(); // chronological order
}

function cleanLlmOutput(text: string): string {
  // Strip markdown code fences
  let cleaned = text.replace(/^```(?:markdown|yaml|md)?\s*\n?/m, "");
  cleaned = cleaned.replace(/\n?```\s*$/m, "");

  // Strip think blocks
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, "");

  // Ensure ends with newline
  if (!cleaned.endsWith("\n")) cleaned += "\n";

  return cleaned.trim() + "\n";
}

// ─── Diff Formatting for Display ────────────────────────────────────────

/**
 * Formats a unified diff for human-readable display in notifications/commands.
 */
export function formatDiffForDisplay(diff: string, maxLines: number = 40): string {
  const lines = diff.split("\n");
  const output: string[] = [];

  let lineCount = 0;
  for (const line of lines) {
    if (lineCount >= maxLines) {
      const remaining = lines.length - lineCount;
      output.push(`  ... ${remaining} more lines (use /forge diff ${diff.match(/\+\+\+ b\/(.+?)\//)?.[1] || "skill"} for full view)`);
      break;
    }
    output.push(`  ${line}`);
    lineCount++;
  }

  return output.join("\n");
}

// ─── Format evolve result for command output ────────────────────────────

export function formatEvolveResult(result: EvolveResult): string {
  const lines: string[] = [];

  if (!result.success) {
    lines.push(`Evolution failed: ${result.error}`);
    return lines.join("\n");
  }

  lines.push(`══ Skill Evolution ══`);
  lines.push(``);

  if (result.distillation) {
    const r = result.distillation;
    lines.push(`Skill: ${r.skill}`);
    lines.push(`Activations: ${r.totalActivations}`);
    lines.push(`Traces: ${r.tracesAtDeploy} at deploy → ${r.tracesNow} now (+${r.newTraceCount})`);
    lines.push(``);

    if (r.divergences.length > 0) {
      lines.push(`Divergences:`);
      for (const d of r.divergences) {
        const icon = d.severity === "high" ? "🔴" : d.severity === "medium" ? "🟡" : "🟢";
        lines.push(`  ${icon} ${d.description}`);
      }
      lines.push(``);
    }
  }

  if (result.diff) {
    lines.push(`Unified Diff:`);
    lines.push(formatDiffForDisplay(result.diff));
    lines.push(``);
  }

  if (result.summary) {
    lines.push(result.summary);
  }

  if (result.proposalName) {
    lines.push(``);
    lines.push(`/forge approve ${result.proposalName}  │  /forge reject ${result.proposalName}`);
    lines.push(`/forge preview ${result.proposalName}   │  Full skill brief`);
  }

  return lines.join("\n");
}
