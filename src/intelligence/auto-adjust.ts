/**
 * Autonomous Skill Adjustment — Phase 2F
 *
 * Micro-revisions from corrected args: when Ace's correctedArgs system detects
 * a correction, this module matches it to the active skill and appends a
 * micro-revision to the skill's anti-patterns or instructions.
 *
 * Micro-revisions are immediate (no approval). 3+ micro-revisions trigger
 * a full LLM rewrite (with approval).
 *
 * Research: Memento-Skills (arXiv:2603.18743) write phase — "the agent updates
 * and expands its skill library based on new experience."
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { getHealthEntries, invalidateHealthCache } from "../skill/lifecycle.js";
import { notify } from "../notify.js";

const HOME = os.homedir() || process.env.HOME || "";
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const ADJUSTMENTS_FILE = path.join(FORGE_DIR, "skill-adjustments.jsonl");

// ─── Types ──────────────────────────────────────────────────────────────

export interface MicroRevision {
  ts: string;
  skill: string;
  type: "anti-pattern" | "instruction-addendum" | "correction-note";
  content: string;
  source: "corrected_args" | "failure" | "user_correction";
  session: string | null;
}

// ─── Apply Micro-Revision ───────────────────────────────────────────────

export function applyMicroRevision(
  skillName: string,
  revision: Omit<MicroRevision, "ts">
): boolean {
  const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
  if (!fsSync.existsSync(skillFile)) return false;

  try {
    const content = fsSync.readFileSync(skillFile, "utf-8");
    const lines = content.split("\n");

    if (revision.type === "anti-pattern") {
      // Find or create Anti-Patterns section
      let apIdx = lines.findIndex(l => /##?\s*anti[- ]?patterns/i.test(l));
      if (apIdx === -1) {
        lines.push("", "## Anti-Patterns", "");
        apIdx = lines.length - 1;
      }
      lines.splice(apIdx + 1, 0, `- [auto] ${revision.content} (${new Date().toISOString().slice(0, 10)})`);
    } else if (revision.type === "instruction-addendum") {
      // Find Instructions section end
      const instrIdx = lines.findIndex(l => /##?\s*(instructions|steps|how\s+to|usage|workflow)/i.test(l));
      if (instrIdx !== -1) {
        // Find next section header
        let endIdx = lines.findIndex((l, i) => i > instrIdx && /^##/.test(l));
        if (endIdx === -1) endIdx = lines.length;
        lines.splice(endIdx, 0, `\n> **Note (auto-adjusted):** ${revision.content}\n`);
      }
    } else {
      // Correction note — append to end before any trailing blank lines
      let insertIdx = lines.length;
      while (insertIdx > 0 && lines[insertIdx - 1].trim() === "") insertIdx--;
      lines.splice(insertIdx, 0, `\n<!-- AceForge auto-correction: ${revision.content} -->`);
    }

    fsSync.writeFileSync(skillFile, lines.join("\n"), "utf-8");

    // Log the adjustment
    const entry: MicroRevision = { ...revision, ts: new Date().toISOString() };
    fsSync.appendFileSync(ADJUSTMENTS_FILE, JSON.stringify(entry) + "\n");

    console.log(`[aceforge/auto-adjust] Micro-revision applied to ${skillName}: ${revision.type}`);
    return true;
  } catch (err) {
    console.error(`[aceforge/auto-adjust] Failed to apply revision: ${(err as Error).message}`);
    return false;
  }
}

// ─── Check if Full Rewrite Needed ───────────────────────────────────────

export function checkRewriteThreshold(skillName: string): boolean {
  if (!fsSync.existsSync(ADJUSTMENTS_FILE)) return false;
  const content = fsSync.readFileSync(ADJUSTMENTS_FILE, "utf-8").trim();
  if (!content) return false;

  const recent = content.split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) as MicroRevision; } catch { return null; } })
    .filter(Boolean)
    .filter(r => r!.skill === skillName) as MicroRevision[];

  // 30-day window
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentRevisions = recent.filter(r => new Date(r.ts).getTime() >= cutoff);

  return recentRevisions.length >= 3;
}

// ─── Handle Correction Event ────────────────────────────────────────────

export function handleCorrectionForSkill(
  toolName: string,
  correctedArgs: string | null,
  failedArgs: string | null,
  session: string | null
): void {
  // Find the skill associated with this tool
  if (!fsSync.existsSync(SKILLS_DIR)) return;

  let matchedSkill: string | null = null;
  for (const skill of fsSync.readdirSync(SKILLS_DIR)) {
    const prefix = skill.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
    if (prefix === toolName) {
      matchedSkill = skill;
      break;
    }
  }

  if (!matchedSkill) return;

  // Build the revision content
  let revisionContent: string;
  if (correctedArgs && failedArgs) {
    revisionContent = `When using ${toolName}: use ${correctedArgs} (not ${failedArgs})`;
  } else if (correctedArgs) {
    revisionContent = `Corrected approach for ${toolName}: ${correctedArgs}`;
  } else {
    return; // No actionable correction
  }

  applyMicroRevision(matchedSkill, {
    skill: matchedSkill,
    type: "anti-pattern",
    content: revisionContent.slice(0, 200),
    source: "corrected_args",
    session,
  });

  // Check if we've hit the rewrite threshold
  if (checkRewriteThreshold(matchedSkill)) {
    notify(
      `Skill Auto-Adjustment Alert\n` +
      `${matchedSkill} has received 3+ micro-revisions in 30 days.\n` +
      `Consider a full rewrite: /forge_quality ${matchedSkill}`
    ).catch(console.error);
  }
}

// ─── Get Adjustment History ─────────────────────────────────────────────

export function getAdjustmentHistory(skillName?: string): MicroRevision[] {
  if (!fsSync.existsSync(ADJUSTMENTS_FILE)) return [];
  const content = fsSync.readFileSync(ADJUSTMENTS_FILE, "utf-8").trim();
  if (!content) return [];

  const all = content.split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) as MicroRevision; } catch { return null; } })
    .filter(Boolean) as MicroRevision[];

  return skillName ? all.filter(r => r.skill === skillName) : all;
}
