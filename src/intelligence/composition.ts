/**
 * Skill Composition — Phase 2C
 *
 * v0.7.2 fix: N-H3 — removed skill-health.jsonl existence gate that blocked
 * co-activation detection when no health entries existed yet. Session data
 * comes from patterns.jsonl, not skill-health.jsonl.
 *
 * Research: AgentSkillOS (arXiv:2603.02176) — DAG-based pipelines "substantially
 * outperform native flat invocation even when given the identical skill set."
 * MACLA (arXiv:2512.18950) — composing atomic procedures into meta-procedures.
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { listActiveSkills } from "../skill/lifecycle.js";
import { generateWorkflowSkillWithLLm } from "../skill/llm-generator.js";
import { writeProposal } from "../skill/generator.js";
import { validateSkillMd } from "../skill/validator.js";
import { notify } from "../notify.js";
import { bold, mono } from "../notify-format.js";
import { appendJsonl } from "../pattern/store.js";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");

// ─── Types ──────────────────────────────────────────────────────────────

export interface CoActivation {
  skillA: string;
  skillB: string;
  coActivationCount: number;
  totalSessionsA: number;
  totalSessionsB: number;
  coActivationRate: number;
  sessions: string[];
}

export interface CompositionCandidate {
  name: string;
  skills: string[];
  coActivationRate: number;
  sessionsObserved: number;
  suggestedFlow: string;
}

// ─── Co-Activation Detection ────────────────────────────────────────────

// N-H3 fix: removed skill-health.jsonl gate — session activations come from patterns.jsonl
function loadSessionActivations(): Map<string, Map<string, number>> {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Map<session, Map<tool, activationCount>>
  const sessionSkills = new Map<string, Map<string, number>>();

  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(patternsFile)) return sessionSkills;

  const pContent = fsSync.readFileSync(patternsFile, "utf-8");
  if (!pContent.trim()) return sessionSkills;

  for (const line of pContent.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.session || !e.tool) continue;
      if (e.type === "correction" || e.type === "chain") continue;
      if (new Date(e.ts).getTime() < cutoff) continue;

      if (!sessionSkills.has(e.session)) sessionSkills.set(e.session, new Map());
      const skills = sessionSkills.get(e.session)!;
      skills.set(e.tool, (skills.get(e.tool) || 0) + 1);
    } catch { /* skip */ }
  }

  return sessionSkills;
}

export function detectCoActivations(minSessions: number = 3, minRate: number = 0.5): CoActivation[] {
  const sessionActivations = loadSessionActivations();
  const activeSkills = listActiveSkills();
  if (activeSkills.length < 2) return [];

  // Map skill → tool name prefix for matching
  const skillToolMap = new Map<string, string>();
  for (const skill of activeSkills) {
    const prefix = skill.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
    skillToolMap.set(skill, prefix);
  }

  // Count co-activations per pair
  const pairCounts = new Map<string, { count: number; sessionsA: Set<string>; sessionsB: Set<string>; coSessions: Set<string> }>();

  for (const [session, toolCounts] of sessionActivations) {
    const sessionTools = [...toolCounts.keys()];

    // For each pair of active skills, check if both are used in this session
    for (let i = 0; i < activeSkills.length; i++) {
      for (let j = i + 1; j < activeSkills.length; j++) {
        const skillA = activeSkills[i];
        const skillB = activeSkills[j];
        const toolA = skillToolMap.get(skillA) || skillA;
        const toolB = skillToolMap.get(skillB) || skillB;

        const aUsed = sessionTools.some(t => t === toolA || t.startsWith(toolA));
        const bUsed = sessionTools.some(t => t === toolB || t.startsWith(toolB));

        const pairKey = `${skillA}|${skillB}`;
        if (!pairCounts.has(pairKey)) {
          pairCounts.set(pairKey, { count: 0, sessionsA: new Set(), sessionsB: new Set(), coSessions: new Set() });
        }
        const pair = pairCounts.get(pairKey)!;

        if (aUsed) pair.sessionsA.add(session);
        if (bUsed) pair.sessionsB.add(session);
        if (aUsed && bUsed) {
          pair.count++;
          pair.coSessions.add(session);
        }
      }
    }
  }

  // Filter and format results
  const results: CoActivation[] = [];

  for (const [pairKey, data] of pairCounts) {
    const [skillA, skillB] = pairKey.split("|");
    const totalSessions = Math.max(data.sessionsA.size, data.sessionsB.size, 1);
    const coRate = data.count / totalSessions;

    if (data.count >= minSessions && coRate >= minRate) {
      results.push({
        skillA,
        skillB,
        coActivationCount: data.count,
        totalSessionsA: data.sessionsA.size,
        totalSessionsB: data.sessionsB.size,
        coActivationRate: Math.round(coRate * 100) / 100,
        sessions: [...data.coSessions],
      });
    }
  }

  results.sort((a, b) => b.coActivationRate - a.coActivationRate);
  return results;
}

// ─── Composition Candidates ─────────────────────────────────────────────

export function getCompositionCandidates(): CompositionCandidate[] {
  const coActivations = detectCoActivations();
  const candidates: CompositionCandidate[] = [];

  for (const co of coActivations) {
    // Generate a composed skill name
    const nameA = co.skillA.replace(/-(guard|skill|operations|workflow).*$/, "").slice(0, 15);
    const nameB = co.skillB.replace(/-(guard|skill|operations|workflow).*$/, "").slice(0, 15);
    const name = `${nameA}-${nameB}-composed`;

    candidates.push({
      name,
      skills: [co.skillA, co.skillB],
      coActivationRate: co.coActivationRate,
      sessionsObserved: co.coActivationCount,
      suggestedFlow: `${co.skillA} → ${co.skillB} (co-activated ${Math.round(co.coActivationRate * 100)}% of sessions)`,
    });
  }

  return candidates;
}

// ─── Composition Execution — Bridge to Workflow Generation ──────────────
// Converts co-activation candidates into actual workflow skill proposals.
// This bridges the detector (detectCoActivations) with the generator
// (generateWorkflowSkillWithLLm) to close the composition loop.

export async function proposeCompositionSkills(): Promise<number> {
  const candidates = getCompositionCandidates();
  if (candidates.length === 0) return 0;

  let proposed = 0;

  for (const candidate of candidates.slice(0, 3)) { // max 3 per cycle
    const proposalName = candidate.name;

    // Skip if already proposed or deployed
    const proposalDir = path.join(FORGE_DIR, "proposals", proposalName);
    if (fsSync.existsSync(proposalDir)) continue;
    const skillDir = path.join(HOME, ".openclaw", "workspace", "skills", proposalName);
    if (fsSync.existsSync(skillDir)) continue;

    // Build a ChainCandidate-compatible structure from co-activation data
    const chainCandidate = {
      toolSequence: candidate.skills.map(s =>
        s.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "")
      ),
      occurrences: candidate.sessionsObserved,
      successRate: candidate.coActivationRate,
      distinctSessions: candidate.sessionsObserved,
      sampleTraces: [] as Array<{ tool: string; args_summary?: string; result_summary?: string; success: boolean; error?: string }[]>,
    };

    try {
      const result = await generateWorkflowSkillWithLLm(chainCandidate);
      if (!result || result.verdict === "REJECT") continue;

      const validation = validateSkillMd(result.skillMd, proposalName);
      if (validation.errors.some((e: string) => e.startsWith("BLOCKED:"))) continue;

      writeProposal(proposalName, result.skillMd);
      appendJsonl("candidates.jsonl", {
        ts: new Date().toISOString(),
        tool: candidate.skills.join("+"),
        type: "composition",
        occurrences: candidate.sessionsObserved,
        coActivationRate: candidate.coActivationRate,
      });

      notify(
        `📋 ${bold("Composition Skill Proposal")}\n\n` +
        `${bold(proposalName)}\n` +
        `${candidate.skills.join(" + ")} activate together ${Math.round(candidate.coActivationRate * 100)}% of sessions (${candidate.sessionsObserved} observed)\n\n` +
        `${mono("/forge preview " + proposalName)}\n${mono("/forge approve " + proposalName)}`
      ).catch(() => {});

      proposed++;
      console.log(`[aceforge] composition proposal: ${proposalName}`);
    } catch (err) {
      console.error(`[aceforge] composition generation error: ${(err as Error).message}`);
    }
  }

  return proposed;
}

// ─── Format for Display ─────────────────────────────────────────────────

export function formatCompositionReport(): string {
  const coActivations = detectCoActivations();
  const candidates = getCompositionCandidates();

  if (coActivations.length === 0) {
    return "No skill co-activation patterns detected yet. Need more session data with multiple skills active.";
  }

  let text = `Skill Composition Analysis\n\n`;
  text += `Co-Activation Patterns:\n`;

  for (const co of coActivations.slice(0, 10)) {
    text += `  ${co.skillA} + ${co.skillB}: ${Math.round(co.coActivationRate * 100)}% co-activation (${co.coActivationCount} sessions)\n`;
  }

  if (candidates.length > 0) {
    text += `\nComposition Candidates:\n`;
    for (const c of candidates.slice(0, 5)) {
      text += `  ${c.name}: ${c.suggestedFlow}\n`;
    }
  }

  return text;
}
