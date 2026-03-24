/**
 * Description Optimizer — Phase 2E
 *
 * v0.7.2 fix: M3 — topTokens now wired into suggestedDescription.
 * The optimizer generates a suggested rewrite from conversation language tokens
 * instead of always returning null.
 *
 * Research: SkillsBench (arXiv:2602.12670) — 56% of skills never invoked because
 * descriptions don't match user intent. Description IS the discovery mechanism.
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { listActiveSkills } from "../skill/lifecycle.js";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");

// ─── Types ──────────────────────────────────────────────────────────────

export interface DescriptionMismatch {
  skill: string;
  currentDescription: string;
  tokenOverlap: number;
  conversationFragments: string[];
  suggestedDescription: string | null;
}

// ─── Token Overlap ──────────────────────────────────────────────────────

function tokenize(s: string): Set<string> {
  const stopWords = new Set(["the", "and", "for", "with", "this", "that", "from", "are", "was", "has",
    "use", "using", "when", "tool", "skill", "auto", "based", "data", "will", "can", "should"]);
  return new Set(
    s.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w))
  );
}

function computeOverlap(descTokens: Set<string>, fragTokens: Set<string>): number {
  if (descTokens.size === 0 || fragTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of descTokens) { if (fragTokens.has(t)) intersection++; }
  return intersection / Math.max(descTokens.size, fragTokens.size);
}

// ─── Collect Conversation Fragments ─────────────────────────────────────

function getRecentConversationFragments(toolName: string): string[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];

  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const fragments: string[] = [];

  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (new Date(entry.ts).getTime() < cutoff) continue;

      // Collect args summaries from tool traces
      if (entry.tool === toolName && entry.args_summary) {
        fragments.push(entry.args_summary);
      }
      // Collect correction text fragments associated with this tool
      if (entry.type === "correction" && entry.text_fragment) {
        fragments.push(entry.text_fragment);
      }
    } catch { /* skip */ }
  }

  return [...new Set(fragments)].slice(0, 20);
}

// ─── Detect Mismatches ──────────────────────────────────────────────────

export function detectDescriptionMismatches(threshold: number = 0.3): DescriptionMismatch[] {
  const skills = listActiveSkills();
  const mismatches: DescriptionMismatch[] = [];

  for (const skill of skills) {
    const skillFile = path.join(SKILLS_DIR, skill, "SKILL.md");
    if (!fsSync.existsSync(skillFile)) continue;

    try {
      const content = fsSync.readFileSync(skillFile, "utf-8");
      const descMatch = content.match(/^description:\s*["']?(.+?)["']?$/m);
      if (!descMatch) continue;

      const currentDesc = descMatch[1].trim();
      const toolPrefix = skill.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
      const fragments = getRecentConversationFragments(toolPrefix);

      if (fragments.length === 0) continue;

      // Compute overlap between description and conversation language
      const descTokens = tokenize(currentDesc);
      const allFragTokens = new Set<string>();
      for (const frag of fragments) {
        for (const t of tokenize(frag)) allFragTokens.add(t);
      }

      const overlap = computeOverlap(descTokens, allFragTokens);

      if (overlap < threshold) {
        // M3 fix: compute top conversation tokens and generate suggested description
        const tokenCounts = new Map<string, number>();
        for (const frag of fragments) {
          for (const t of tokenize(frag)) {
            tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
          }
        }
        const topTokens = [...tokenCounts.entries()]
          .sort(([, a], [, b]) => b - a)
          .slice(0, 8)
          .map(([t]) => t);

        // Generate a suggested description from the top conversation tokens
        // Preserve any existing action verb from the current description
        const currentVerb = currentDesc.split(/\s+/)[0]?.toLowerCase() || "";
        const actionVerbs = ["use", "run", "execute", "deploy", "configure", "manage", "handle",
          "process", "generate", "create", "build", "check", "verify", "search", "fetch",
          "extract", "parse", "monitor", "debug", "fix", "install", "update", "clean"];
        const verb = actionVerbs.includes(currentVerb) ? currentDesc.split(/\s+/)[0] : "Handle";

        const suggestedDescription = topTokens.length >= 3
          ? `${verb} ${topTokens.slice(0, 5).join(", ")} operations for ${toolPrefix}`
          : null;

        mismatches.push({
          skill,
          currentDescription: currentDesc,
          tokenOverlap: Math.round(overlap * 100) / 100,
          conversationFragments: fragments.slice(0, 5),
          suggestedDescription,
        });
      }
    } catch { /* skip unreadable */ }
  }

  mismatches.sort((a, b) => a.tokenOverlap - b.tokenOverlap);
  return mismatches;
}

// ─── Format Report ──────────────────────────────────────────────────────

export function formatOptimizationReport(): string {
  const mismatches = detectDescriptionMismatches();

  if (mismatches.length === 0) {
    return "All skill descriptions match recent conversation language. No optimization needed.";
  }

  let text = `Description Optimization Report\n\n`;
  text += `${mismatches.length} skill(s) with description-language mismatch:\n\n`;

  for (const m of mismatches) {
    text += `${m.skill} — ${Math.round(m.tokenOverlap * 100)}% overlap\n`;
    text += `  Current: "${m.currentDescription.slice(0, 80)}"\n`;
    text += `  User says: "${m.conversationFragments[0]?.slice(0, 60) || ""}"\n`;
    if (m.suggestedDescription) {
      text += `  Suggested: "${m.suggestedDescription}"\n`;
    }
    text += `\n`;
  }

  return text;
}
