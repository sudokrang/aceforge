/**
 * Analyze Utilities — Shared filesystem helpers for pattern analysis
 *
 * v0.8.1: Extracted from analyze.ts to avoid circular dependencies
 * between analyze.ts ↔ analyze-native.ts ↔ analyze-chains.ts.
 *
 * These are pure filesystem operations: reading patterns/candidates,
 * checking for existing proposals/skills, and logging filtered candidates.
 */
import * as fsSync from "fs";
import * as path from "path";
import { appendJsonl } from "./store.js";
import {
  FORGE_DIR, SKILLS_DIR, PROPOSALS_DIR,
  type PatternEntry,
} from "./constants.js";

// ─── File Readers ───────────────────────────────────────────────────────

export function readCandidatesFile(): { tool: string; args_summary_prefix: string }[] {
  const file = path.join(FORGE_DIR, "candidates.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as { tool: string; args_summary_prefix: string }[];
}

export function readPatternsFile(): PatternEntry[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line) as PatternEntry; } catch { return null; } })
    .filter(Boolean) as PatternEntry[];
}

// ─── Filtered Candidate Logging ─────────────────────────────────────────
// Every time a candidate is suppressed by a quality gate, log WHY
// so operators can review with /forge filtered

export function logFilteredCandidate(
  tool: string,
  reason: string,
  detail: string,
  meta?: Record<string, unknown>
): void {
  appendJsonl("filtered-candidates.jsonl", {
    ts: new Date().toISOString(),
    tool,
    reason,
    detail,
    ...meta,
  });
  console.log(`[aceforge] filtered: ${tool} — ${reason}: ${detail}`);
}

// ─── Proposal / Skill Deduplication Checks ──────────────────────────────

/**
 * Check if a tool has an ACTIVE proposal or deployed skill.
 * N-M1 fix: bundledTools parsed from YAML frontmatter, not JSON.
 */
export function hasActiveProposalOrSkill(tool: string): boolean {
  // Check proposals directory
  if (fsSync.existsSync(PROPOSALS_DIR)) {
    const proposals = fsSync.readdirSync(PROPOSALS_DIR);
    if (proposals.some(p => p === tool || p.startsWith(tool + "-"))) return true;
  }
  // Check deployed skills
  if (fsSync.existsSync(SKILLS_DIR)) {
    const skills = fsSync.readdirSync(SKILLS_DIR);
    if (skills.some(s => {
      try { return fsSync.statSync(path.join(SKILLS_DIR, s)).isDirectory() && (s === tool || s.startsWith(tool + "-")); }
      catch { return false; }
    })) return true;
  }
  // N-M1 fix: Check if any installed skill explicitly wraps this tool via bundledTools
  // SKILL.md uses YAML frontmatter, not JSON — parse accordingly
  if (fsSync.existsSync(SKILLS_DIR)) {
    const skills = fsSync.readdirSync(SKILLS_DIR);
    for (const s of skills) {
      try {
        const skillPath = path.join(SKILLS_DIR, s);
        if (!fsSync.statSync(skillPath).isDirectory()) continue;
        const mdPath = path.join(skillPath, "SKILL.md");
        if (!fsSync.existsSync(mdPath)) continue;
        const content = fsSync.readFileSync(mdPath, "utf-8");

        // Parse bundledTools from YAML frontmatter:
        //   bundledTools: [tavily_search, tavily_extract]
        // or:
        //   bundledTools:
        //     - tavily_search
        //     - tavily_extract
        const inlineMatch = content.match(/bundledTools:\s*\[([^\]]+)\]/);
        if (inlineMatch) {
          const tools = inlineMatch[1].split(",").map(t => t.trim().replace(/['"]/g, ""));
          if (tools.includes(tool)) return true;
        }
        // Multi-line YAML array
        const multiLineMatch = content.match(/bundledTools:\s*\n((?:\s+-\s+\S+\n?)+)/);
        if (multiLineMatch) {
          const tools = multiLineMatch[1].split("\n")
            .map(l => l.replace(/^\s*-\s*/, "").trim().replace(/['"]/g, ""))
            .filter(Boolean);
          if (tools.includes(tool)) return true;
        }

        // Fallback: check if description mentions the tool (heuristic)
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?$/m);
        if (descMatch && descMatch[1].toLowerCase().includes(tool.replace(/_/g, " ").toLowerCase())) {
          return true;
        }
      } catch { /* skip unreadable skills */ }
    }
  }
  return false;
}

/** Find the deployed skill name that matches a tool, if any */
export function findDeployedSkill(tool: string): string | null {
  if (!fsSync.existsSync(SKILLS_DIR)) return null;
  return fsSync.readdirSync(SKILLS_DIR).find(s => {
    try { return fsSync.statSync(path.join(SKILLS_DIR, s)).isDirectory() && (s === tool || s.startsWith(tool + "-")); }
    catch { return false; }
  }) || null;
}

/** F1 fix: Check if any existing PROPOSAL already covers this tool */
export function hasProposalForSameTool(tool: string): string | null {
  if (!fsSync.existsSync(PROPOSALS_DIR)) return null;
  for (const proposalName of fsSync.readdirSync(PROPOSALS_DIR)) {
    const propDir = path.join(PROPOSALS_DIR, proposalName);
    try {
      if (!fsSync.statSync(propDir).isDirectory()) continue;
      const mdPath = path.join(propDir, "SKILL.md");
      if (!fsSync.existsSync(mdPath)) continue;
      const content = fsSync.readFileSync(mdPath, "utf-8");

      // Check bundledTools
      const inlineMatch = content.match(/bundledTools:\s*\[([^\]]+)\]/);
      if (inlineMatch) {
        const tools = inlineMatch[1].split(",").map(t => t.trim().replace(/['"]/g, ""));
        if (tools.includes(tool)) return proposalName;
      }
      const multiLineMatch = content.match(/bundledTools:\s*\n((?:\s+-\s+\S+\n?)+)/);
      if (multiLineMatch) {
        const tools = multiLineMatch[1].split("\n")
          .map(l => l.replace(/^\s*-\s*/, "").trim().replace(/['"]/g, ""))
          .filter(Boolean);
        if (tools.includes(tool)) return proposalName;
      }

      // Check if proposal name maps to this tool
      const prefix = proposalName.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
      if (prefix === tool) return proposalName;
    } catch { /* skip */ }
  }
  return null;
}

/** Check if a proposal already exists for this name */
export function hasExistingProposal(name: string): boolean {
  if (!fsSync.existsSync(PROPOSALS_DIR)) return false;
  return fsSync.readdirSync(PROPOSALS_DIR).some(p => p === name || p.startsWith(name));
}
