/**
 * Skill Composition — Phase 2C
 *
 * Detects when two skills frequently co-activate in the same session and proposes
 * composed skills that chain them with explicit data flow.
 *
 * Research: AgentSkillOS (arXiv:2603.02176) — DAG-based pipelines "substantially
 * outperform native flat invocation even when given the identical skill set."
 * MACLA (arXiv:2512.18950) — composing atomic procedures into meta-procedures.
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { getHealthEntries, listActiveSkills } from "../skill/lifecycle.js";

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

function loadSessionActivations(): Map<string, Map<string, number>> {
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  if (!fsSync.existsSync(healthFile)) return new Map();

  const content = fsSync.readFileSync(healthFile, "utf-8");
  if (!content.trim()) return new Map();

  // Map<session, Map<skill, activationCount>>
  const sessionSkills = new Map<string, Map<string, number>>();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Also load patterns for session context
  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  const patterns: Array<{ ts: string; tool: string; session: string }> = [];
  if (fsSync.existsSync(patternsFile)) {
    const pContent = fsSync.readFileSync(patternsFile, "utf-8");
    for (const line of pContent.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.session && e.tool && new Date(e.ts).getTime() >= cutoff) {
          patterns.push(e);
        }
      } catch { /* skip */ }
    }
  }

  // Group tool calls by session
  for (const p of patterns) {
    if (!sessionSkills.has(p.session)) sessionSkills.set(p.session, new Map());
    const skills = sessionSkills.get(p.session)!;
    skills.set(p.tool, (skills.get(p.tool) || 0) + 1);
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
      text += `    Propose: /forge_compose ${c.skills.join(" ")}\n`;
    }
  }

  return text;
}
