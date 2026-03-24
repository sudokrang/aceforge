/**
 * Skill Quality Scoring Engine — AceForge v0.6.0
 *
 * Deterministic structural + coverage scoring for SKILL.md files.
 * No LLM calls. Pure text analysis. Runs in milliseconds.
 *
 * v0.6.0 fixes:
 *  - H3: replaced require() with static ESM import (was crashing in pure ESM)
 *  - M2: replaced \Z regex anchor with $ (JS doesn't support \Z)
 */
import * as fsSync from "fs";
import * as path from "path";
import { getHealthEntries } from "./lifecycle.js";

const FORGE_DIR = path.join(
  process.env.HOME || "~",
  ".openclaw",
  "workspace",
  ".forge"
);

interface ScoreBreakdown {
  triggerClarity: number;
  sectionStructure: number;
  proceduralDepth: number;
  antiPatternGrounding: number;
  conciseness: number;
  metadataCompleteness: number;
  securityHygiene: number;
}

interface CoverageBreakdown {
  argsPatternCoverage: number;
  failureCoverage: number;
  correctionCoverage: number;
  usageRecency: number;
  successImprovement: number;
}

export interface QualityReport {
  structural: number;
  coverage: number;
  combined: number;
  structuralBreakdown: ScoreBreakdown;
  coverageBreakdown: CoverageBreakdown;
  deficiencies: string[];
  strengths: string[];
}

// ─── Structural Scoring ──────────────────────────────────────────

export function scoreStructural(skillMd: string): { total: number; breakdown: ScoreBreakdown; notes: string[] } {
  const lines = skillMd.split("\n");
  const notes: string[] = [];

  // 1. Trigger clarity (0-20)
  let triggerClarity = 0;
  const descMatch = skillMd.match(/^description:\s*["']?(.+?)["']?$/m);
  if (descMatch) {
    const desc = descMatch[1].trim();
    const sentences = desc.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const wordCount = desc.split(/\s+/).length;

    if (sentences.length === 1 && wordCount <= 25) {
      triggerClarity = 20;
    } else if (sentences.length === 1 && wordCount <= 40) {
      triggerClarity = 15;
    } else if (sentences.length <= 2) {
      triggerClarity = 10;
      notes.push("Description has multiple sentences — should be one trigger phrase");
    } else {
      triggerClarity = 5;
      notes.push("Description is a paragraph, not a trigger sentence");
    }

    const firstWord = desc.split(/\s+/)[0]?.toLowerCase() || "";
    const actionVerbs = ["use", "run", "execute", "deploy", "configure", "manage", "handle",
      "process", "generate", "create", "build", "check", "verify", "search", "fetch",
      "extract", "parse", "monitor", "debug", "fix", "install", "update", "clean"];
    if (actionVerbs.some(v => firstWord.startsWith(v))) {
      triggerClarity = Math.min(20, triggerClarity + 3);
    }
  } else {
    notes.push("Missing description field");
  }

  // 2. Section structure (0-20)
  let sectionStructure = 0;
  const sectionPatterns = [
    { name: "When to Use", pattern: /##?\s*when\s+to\s+use/i, weight: 5 },
    { name: "Pre-flight", pattern: /##?\s*pre[- ]?flight/i, weight: 3 },
    { name: "Instructions", pattern: /##?\s*(instructions|steps|how\s+to|usage|workflow)/i, weight: 5 },
    { name: "Error Recovery", pattern: /##?\s*(error\s+recovery|troubleshoot|when\s+.+\s+fails)/i, weight: 3 },
    { name: "Anti-Patterns", pattern: /##?\s*anti[- ]?patterns/i, weight: 4 },
  ];
  for (const sp of sectionPatterns) {
    if (sp.pattern.test(skillMd)) {
      sectionStructure += sp.weight;
    } else {
      notes.push(`Missing section: ${sp.name}`);
    }
  }

  // 3. Procedural depth (0-20)
  let proceduralDepth = 0;
  const hasCodeBlocks = /```/.test(skillMd) || /`[^`]+`/.test(skillMd);
  const hasSpecificArgs = /--[\w-]+|`[\w_]+`\s*[:=]|"[\w./-]+"/.test(skillMd);
  const hasNumberedSteps = /^\s*\d+\.\s+/m.test(skillMd);
  const hasExpectedOutput = /expected\s+(output|result)|returns?\s+|output\s*:/i.test(skillMd);
  const hasConditionalLogic = /if\s+.+,?\s+(then|use|run)|when\s+.+,?\s+(instead|use|try)/i.test(skillMd);

  if (hasCodeBlocks) proceduralDepth += 5;
  if (hasSpecificArgs) proceduralDepth += 5;
  if (hasNumberedSteps) proceduralDepth += 4;
  if (hasExpectedOutput) proceduralDepth += 3;
  if (hasConditionalLogic) proceduralDepth += 3;

  if (proceduralDepth < 10) {
    notes.push("Instructions lack specific arguments, expected outputs, or decision logic");
  }

  // 4. Anti-pattern grounding (0-15) — M2 fix: replaced \Z with $
  let antiPatternGrounding = 0;
  const antiPatternSection = skillMd.match(/##?\s*anti[- ]?patterns?\s*\n([\s\S]*?)(?=\n##|\n---|$)/i);
  if (antiPatternSection) {
    const apContent = antiPatternSection[1];
    const bulletCount = (apContent.match(/^\s*[-*]\s+/gm) || []).length;
    const hasSpecificErrors = /error|fail|timeout|permission|denied|crash|404|500|ENOENT|EACCES/i.test(apContent);
    const hasSpecificCommands = /`[^`]+`/.test(apContent);

    if (bulletCount >= 3 && hasSpecificErrors) {
      antiPatternGrounding = 15;
    } else if (bulletCount >= 2 && (hasSpecificErrors || hasSpecificCommands)) {
      antiPatternGrounding = 12;
    } else if (bulletCount >= 1) {
      antiPatternGrounding = 7;
      notes.push("Anti-patterns section exists but lacks specific error patterns");
    } else {
      antiPatternGrounding = 3;
      notes.push("Anti-patterns section is empty or boilerplate");
    }
  } else {
    notes.push("No anti-patterns section");
  }

  // 5. Conciseness (0-10)
  let conciseness = 0;
  const lineCount = lines.length;
  if (lineCount <= 100) {
    conciseness = 10;
  } else if (lineCount <= 150) {
    conciseness = 8;
  } else if (lineCount <= 250) {
    conciseness = 5;
    notes.push("Skill exceeds 150 lines — consider focusing on dominant patterns");
  } else {
    conciseness = 2;
    notes.push("Skill is very long (" + lineCount + " lines) — comprehensive docs hurt more than they help");
  }

  // 6. Metadata completeness (0-10)
  let metadataCompleteness = 0;
  if (/^name:\s*.+/m.test(skillMd)) metadataCompleteness += 3;
  else notes.push("Missing name in frontmatter");
  if (descMatch) metadataCompleteness += 3;
  if (/metadata:\s*\n\s+openclaw:\s*\n\s+category:/m.test(skillMd)) metadataCompleteness += 4;
  else if (/category:/m.test(skillMd)) metadataCompleteness += 2;
  else notes.push("Missing category metadata");

  // 7. Security hygiene (0-5)
  let securityHygiene = 5;
  if (/api[_-]?key\s*[:=]\s*["'][^"']{16,}/i.test(skillMd)) {
    securityHygiene -= 3;
    notes.push("Contains potential API key in plaintext");
  }
  if (/ignore\s+previous\s+instructions/i.test(skillMd)) {
    securityHygiene -= 2;
    notes.push("Contains injection-like pattern");
  }

  const breakdown: ScoreBreakdown = {
    triggerClarity,
    sectionStructure,
    proceduralDepth,
    antiPatternGrounding,
    conciseness,
    metadataCompleteness,
    securityHygiene,
  };

  const total = triggerClarity + sectionStructure + proceduralDepth +
    antiPatternGrounding + conciseness + metadataCompleteness + securityHygiene;

  return { total, breakdown, notes };
}

// ─── Coverage Scoring ────────────────────────────────────────────

interface TraceEntry {
  ts: string;
  tool: string;
  args_summary: string | null;
  result_summary?: string | null;
  success: boolean;
  error?: string | null;
  type?: string;
  text_fragment?: string;
}

function loadTraces(toolName: string): { traces: TraceEntry[]; corrections: TraceEntry[] } {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return { traces: [], corrections: [] };
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return { traces: [], corrections: [] };

  const traces: TraceEntry[] = [];
  const corrections: TraceEntry[] = [];

  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TraceEntry;
      if (e.tool === toolName && e.type !== "correction" && e.type !== "chain") {
        traces.push(e);
      }
      if (e.type === "correction") {
        corrections.push(e);
      }
    } catch { /* skip */ }
  }

  return { traces, corrections };
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter(w => w.length > 2);
}

function tokenOverlap(textA: string, textB: string): number {
  const tokensA = new Set(tokenize(textA));
  const tokensB = new Set(tokenize(textB));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  return intersection / Math.max(tokensA.size, tokensB.size);
}

export function scoreCoverage(skillMd: string, toolName: string): { total: number; breakdown: CoverageBreakdown; notes: string[] } {
  const { traces, corrections } = loadTraces(toolName);
  const notes: string[] = [];

  if (traces.length === 0) {
    notes.push("No trace data available for coverage scoring");
    return {
      total: 50,
      breakdown: {
        argsPatternCoverage: 15,
        failureCoverage: 12,
        correctionCoverage: 12,
        usageRecency: 5,
        successImprovement: 6,
      },
      notes,
    };
  }

  // 1. Args pattern coverage (0-30)
  let argsPatternCoverage = 0;
  const argsSummaries = traces
    .map(t => t.args_summary || "")
    .filter(a => a.length > 0);

  if (argsSummaries.length > 0) {
    const allArgTokens = new Set<string>();
    for (const args of argsSummaries) {
      for (const t of tokenize(args)) allArgTokens.add(t);
    }

    const skillTokens = new Set(tokenize(skillMd));
    let covered = 0;
    for (const t of allArgTokens) {
      if (skillTokens.has(t)) covered++;
    }

    const ratio = allArgTokens.size > 0 ? covered / allArgTokens.size : 0;
    argsPatternCoverage = Math.round(ratio * 30);

    if (ratio < 0.3) {
      notes.push(`Skill covers only ${Math.round(ratio * 100)}% of argument patterns from traces`);
    }
  } else {
    argsPatternCoverage = 15;
  }

  // 2. Failure coverage (0-25) — M2 fix: $ instead of \Z
  let failureCoverage = 0;
  const failures = traces.filter(t => !t.success);
  const antiPatternSection = skillMd.match(/##?\s*anti[- ]?patterns?\s*\n([\s\S]*?)(?=\n##|\n---|$)/i);
  const apText = antiPatternSection ? antiPatternSection[1] : "";

  if (failures.length === 0) {
    failureCoverage = 25;
  } else if (failures.length > 0 && apText.length > 0) {
    const errorMessages = failures
      .map(f => f.error || f.result_summary || "")
      .filter(e => typeof e === "string" && e.length > 0);

    let coveredErrors = 0;
    for (const err of errorMessages) {
      if (tokenOverlap(err, apText) > 0.15) coveredErrors++;
    }

    const ratio = errorMessages.length > 0 ? coveredErrors / errorMessages.length : 0;
    failureCoverage = Math.round(ratio * 25);

    if (ratio < 0.3) {
      notes.push(`Anti-patterns cover only ${Math.round(ratio * 100)}% of observed failures (${failures.length} failures in traces)`);
    }
  } else if (failures.length > 0) {
    failureCoverage = 0;
    notes.push(`${failures.length} failures in traces but skill has no anti-patterns section`);
  }

  // 3. Correction coverage (0-25)
  let correctionCoverage = 0;
  if (corrections.length === 0) {
    correctionCoverage = 25;
  } else {
    const correctionTexts = corrections
      .map(c => c.text_fragment || c.args_summary || "")
      .filter(t => t.length > 0);

    let coveredCorr = 0;
    for (const ct of correctionTexts) {
      if (tokenOverlap(ct, skillMd) > 0.15) coveredCorr++;
    }

    const ratio = correctionTexts.length > 0 ? coveredCorr / correctionTexts.length : 0;
    correctionCoverage = Math.round(ratio * 25);

    if (ratio < 0.3) {
      notes.push(`Skill addresses only ${Math.round(ratio * 100)}% of ${corrections.length} user corrections`);
    }
  }

  // 4. Usage recency (0-10)
  let usageRecency = 0;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const recentTraces = traces.filter(t => Date.now() - new Date(t.ts).getTime() < SEVEN_DAYS_MS);

  if (recentTraces.length === 0) {
    usageRecency = 5;
  } else {
    const recentArgTokens = new Set<string>();
    for (const t of recentTraces) {
      if (t.args_summary) {
        for (const tok of tokenize(t.args_summary)) recentArgTokens.add(tok);
      }
    }

    const skillTokens = new Set(tokenize(skillMd));
    let covered = 0;
    for (const t of recentArgTokens) {
      if (skillTokens.has(t)) covered++;
    }

    const ratio = recentArgTokens.size > 0 ? covered / recentArgTokens.size : 0;
    usageRecency = Math.round(ratio * 10);
  }

  // 5. Success improvement (0-10) — H3 fix: uses static import now
  let successImprovement = 5;
  try {
    const SKILLS_DIR_QS = path.join(process.env.HOME || "~", ".openclaw", "workspace", "skills");
    if (fsSync.existsSync(SKILLS_DIR_QS)) {
      for (const dir of fsSync.readdirSync(SKILLS_DIR_QS)) {
        if (dir.startsWith(toolName) || dir === toolName) {
          const entries = getHealthEntries(dir);
          const baseline = entries.find((e) => e.action === "deployment_baseline");
          if (baseline) {
            const postDeploy = entries.filter((e) =>
              e.action === "activation" && new Date(e.ts).getTime() > new Date(baseline.ts).getTime()
            );
            if (postDeploy.length >= 10) {
              const postSuccess = postDeploy.filter((e) => e.success).length / postDeploy.length;
              const preSuccess = traces.length > 0 ? traces.filter(t => t.success).length / traces.length : 0;
              const delta = postSuccess - preSuccess;
              if (delta > 0.1) successImprovement = 10;
              else if (delta > 0) successImprovement = 7;
              else if (delta > -0.1) successImprovement = 4;
              else {
                successImprovement = 0;
                notes.push("Success rate has declined since skill deployment");
              }
            }
          }
          break;
        }
      }
    }
  } catch { /* graceful fallback to neutral score */ }

  const breakdown: CoverageBreakdown = {
    argsPatternCoverage,
    failureCoverage,
    correctionCoverage,
    usageRecency,
    successImprovement,
  };

  const total = argsPatternCoverage + failureCoverage + correctionCoverage +
    usageRecency + successImprovement;

  return { total, breakdown, notes };
}

// ─── Combined Scoring ────────────────────────────────────────────

export function scoreSkill(skillMd: string, toolName: string): QualityReport {
  const structural = scoreStructural(skillMd);
  const coverage = scoreCoverage(skillMd, toolName);

  const combined = Math.round(0.4 * structural.total + 0.6 * coverage.total);

  const deficiencies = [...structural.notes, ...coverage.notes];
  const strengths: string[] = [];

  if (structural.breakdown.triggerClarity >= 18) strengths.push("Strong trigger description");
  if (structural.breakdown.sectionStructure >= 16) strengths.push("Good progressive disclosure structure");
  if (structural.breakdown.proceduralDepth >= 16) strengths.push("Deep procedural instructions");
  if (structural.breakdown.antiPatternGrounding >= 12) strengths.push("Well-grounded anti-patterns");
  if (coverage.breakdown.argsPatternCoverage >= 24) strengths.push("Good coverage of actual usage patterns");
  if (coverage.breakdown.failureCoverage >= 20) strengths.push("Addresses observed failures");

  return {
    structural: structural.total,
    coverage: coverage.total,
    combined,
    structuralBreakdown: structural.breakdown,
    coverageBreakdown: coverage.breakdown,
    deficiencies,
    strengths,
  };
}

// ─── Human-readable report ───────────────────────────────────────

export function formatQualityReport(report: QualityReport, skillName: string): string {
  let text = `Quality Report: ${skillName}\n`;
  text += `Combined: ${report.combined}/100 (structural: ${report.structural}, coverage: ${report.coverage})\n\n`;

  text += `Structural Breakdown:\n`;
  text += `  Trigger clarity:    ${report.structuralBreakdown.triggerClarity}/20\n`;
  text += `  Section structure:  ${report.structuralBreakdown.sectionStructure}/20\n`;
  text += `  Procedural depth:   ${report.structuralBreakdown.proceduralDepth}/20\n`;
  text += `  Anti-pattern:       ${report.structuralBreakdown.antiPatternGrounding}/15\n`;
  text += `  Conciseness:        ${report.structuralBreakdown.conciseness}/10\n`;
  text += `  Metadata:           ${report.structuralBreakdown.metadataCompleteness}/10\n`;
  text += `  Security:           ${report.structuralBreakdown.securityHygiene}/5\n\n`;

  text += `Coverage Breakdown:\n`;
  text += `  Args patterns:      ${report.coverageBreakdown.argsPatternCoverage}/30\n`;
  text += `  Failure coverage:   ${report.coverageBreakdown.failureCoverage}/25\n`;
  text += `  Correction coverage:${report.coverageBreakdown.correctionCoverage}/25\n`;
  text += `  Usage recency:      ${report.coverageBreakdown.usageRecency}/10\n`;
  text += `  Success improvement:${report.coverageBreakdown.successImprovement}/10\n`;

  if (report.strengths.length > 0) {
    text += `\nStrengths:\n`;
    for (const s of report.strengths) text += `  + ${s}\n`;
  }

  if (report.deficiencies.length > 0) {
    text += `\nDeficiencies:\n`;
    for (const d of report.deficiencies) text += `  - ${d}\n`;
  }

  return text;
}
