/**
 * Grounded Challenges — Phase 3B
 *
 * v0.7.2 fix: M5 — Viking search now passes target_uri for scoped queries.
 *
 * Research: SE-Agent (arXiv:2508.02085) — curriculum generation for progressive testing.
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { listActiveSkills, getSkillStats } from "../skill/lifecycle.js";
import { searchViking, checkVikingHealth } from "../viking/client.js";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
const CHALLENGES_FILE = path.join(FORGE_DIR, "challenges.jsonl");

// ─── Types ──────────────────────────────────────────────────────────────

export interface Challenge {
  id: string;
  ts: string;
  targetSkill: string;
  prompt: string;
  expectedBehavior: string;
  source: "viking" | "pattern" | "generated";
  result?: "pass" | "fail" | "skip" | "pending";
  notes?: string;
}

// ─── Generate from Pattern Data ─────────────────────────────────────────

function generateFromPatterns(skillName: string): Challenge | null {
  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(patternsFile)) return null;

  const content = fsSync.readFileSync(patternsFile, "utf-8").trim();
  if (!content) return null;

  const toolPrefix = skillName.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
  const successTraces: Array<{ args_summary: string; result_summary: string }> = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.tool === toolPrefix && entry.success && entry.args_summary) {
        successTraces.push(entry);
      }
    } catch { /* skip */ }
  }

  if (successTraces.length === 0) return null;

  const trace = successTraces[Math.floor(Math.random() * successTraces.length)];

  return {
    id: `challenge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    targetSkill: skillName,
    prompt: `Execute the following task: ${trace.args_summary}`,
    expectedBehavior: `Skill '${skillName}' should activate. Expected result pattern: ${(trace.result_summary || "success").slice(0, 100)}`,
    source: "pattern",
  };
}

// ─── Generate from Viking Context ───────────────────────────────────────

async function generateFromViking(skillName: string): Promise<Challenge | null> {
  try {
    const health = await checkVikingHealth();
    if (!health.available) return null;

    const toolPrefix = skillName.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
    // M5 fix: scope Viking search to user memories for operational context
    const result = await searchViking(
      `recent ${toolPrefix} operations tasks`,
      "viking://user/memories/"
    );
    if (!result) return null;

    const context = typeof result === "string" ? result :
      Array.isArray(result) ? (result as any[]).map(r => r.text || r.content || "").join("; ") :
      JSON.stringify(result).slice(0, 200);

    if (!context || context.length < 10) return null;

    return {
      id: `challenge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      targetSkill: skillName,
      prompt: `Based on recent operational context: ${context.slice(0, 150)}. Handle this task.`,
      expectedBehavior: `Skill '${skillName}' should activate and handle the task based on its instructions.`,
      source: "viking",
    };
  } catch {
    return null;
  }
}

// ─── Generate Challenges ────────────────────────────────────────────────

export async function generateChallenges(maxPerSkill: number = 2): Promise<Challenge[]> {
  const skills = listActiveSkills();
  const challenges: Challenge[] = [];

  for (const skill of skills) {
    const stats = getSkillStats(skill);
    if (stats.activations < 3) continue;

    let challenge = await generateFromViking(skill);
    if (!challenge) {
      challenge = generateFromPatterns(skill);
    }

    if (challenge) {
      challenges.push(challenge);
      try {
        fsSync.appendFileSync(CHALLENGES_FILE, JSON.stringify(challenge) + "\n");
      } catch { /* non-critical */ }
    }
  }

  return challenges;
}

// ─── Record Challenge Result ────────────────────────────────────────────

export function recordChallengeResult(challengeId: string, result: "pass" | "fail" | "skip", notes?: string): void {
  try {
    fsSync.appendFileSync(CHALLENGES_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      challengeId,
      result,
      notes: notes?.slice(0, 200),
    }) + "\n");
  } catch { /* non-critical */ }
}

// ─── Get Recent Results ─────────────────────────────────────────────────

export function getRecentChallengeResults(): Array<{ skill: string; result: string; ts: string }> {
  if (!fsSync.existsSync(CHALLENGES_FILE)) return [];
  const content = fsSync.readFileSync(CHALLENGES_FILE, "utf-8").trim();
  if (!content) return [];

  return content.split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter(e => e.targetSkill && e.result)
    .slice(-20) as Array<{ skill: string; result: string; ts: string }>;
}

// ─── Format Report ──────────────────────────────────────────────────────

export function formatChallengeReport(challenges: Challenge[]): string {
  if (challenges.length === 0) return "No challenges generated. Skills need more activation history (3+ activations) first.";

  let text = `Grounded Challenge Report\n\n`;
  text += `${challenges.length} challenge(s) generated:\n\n`;

  for (const c of challenges) {
    text += `${c.targetSkill} (${c.source})\n`;
    text += `  Prompt: ${c.prompt.slice(0, 80)}\n`;
    text += `  Expected: ${c.expectedBehavior.slice(0, 80)}\n`;
    text += `  Status: ${c.result || "pending"}\n\n`;
  }

  return text;
}
