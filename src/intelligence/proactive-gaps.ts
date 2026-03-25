/**
 * Proactive Gap Detection — Phase 2D
 *
 * Enhances existing gap-detect.ts with agent behavior pattern detection:
 * - Fallback patterns: "I can't do that" / "you'll need to manually"
 * - Deferral patterns: "let me know if you want me to..."
 * - Uncertainty patterns: "I think" / "I'm not sure" before tool calls
 * - Infrastructure gaps: "requires access to" / "you'll need to install"
 *
 * Research: EvoSkill (arXiv:2603.02766) — Proposer agent "analyzes failure traces,
 * finds repeated patterns, and suggests what kind of skill could help."
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { buildCapabilityTree, type CapabilityTree } from "./capability-tree.js";

// Audit fix: cache patterns.jsonl reads — avoid re-parsing on every agent_end
let _patternsCache: { data: any[]; ts: number } | null = null;
const PATTERNS_CACHE_TTL_MS = 10000; // 10 seconds

function readPatternsCached(): any[] {
  if (_patternsCache && Date.now() - _patternsCache.ts < PATTERNS_CACHE_TTL_MS) {
    return _patternsCache.data;
  }
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  // Audit fix: use cached read
  return readPatternsCached();
  if (!content.trim()) return [];
  const data = content.trim().split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  _patternsCache = { data, ts: Date.now() };
  return data;
}


const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");

// ─── Types ──────────────────────────────────────────────────────────────

export interface BehaviorGap {
  type: "fallback" | "deferral" | "uncertainty" | "infrastructure";
  tool: string | null;
  session: string | null;
  text: string;
  ts: string;
  domain: string;
}

export interface GapSummary {
  domain: string;
  gapType: string;
  count: number;
  examples: string[];
  suggestedAction: string;
}

// ─── Pattern Definitions ────────────────────────────────────────────────

const FALLBACK_PATTERNS = [
  /i (?:can't|cannot|am unable to|am not able to) (?:do|perform|complete|execute|handle) that/i,
  /you(?:'ll| will) need to (?:do|handle|complete|perform) (?:this|that|it) (?:manually|yourself)/i,
  /(?:this|that) (?:is|requires) (?:beyond|outside) (?:my|the) (?:capabilities|scope|ability)/i,
  /i don't have (?:access|permission|the ability) to/i,
  /(?:unfortunately|sorry),? i (?:can't|cannot)/i,
];

const DEFERRAL_PATTERNS = [
  /(?:let|shall) me know (?:if|when|whether) you (?:want|would like|need) me to/i,
  /would you like me to (?:try|attempt|proceed|go ahead)/i,
  /i (?:can|could) (?:try|attempt) (?:to|that) if you(?:'d| would) like/i,
  /(?:should|shall) i (?:proceed|go ahead|continue)/i,
  /i'?(?:ll| will) wait for (?:your|the) (?:approval|confirmation|go-ahead)/i,
];

const UNCERTAINTY_PATTERNS = [
  /i (?:think|believe|suspect) (?:that |this |the )/i,
  /i'm not (?:sure|certain|confident) (?:about|whether|if|that)/i,
  /(?:this|it) (?:might|may|could) (?:be|cause|result in)/i,
  /i (?:haven't|have not) (?:verified|confirmed|checked|tested)/i,
];

const INFRASTRUCTURE_PATTERNS = [
  /(?:requires?|needs?) (?:access to|installation of|the|a) /i,
  /you(?:'ll| will) need to install/i,
  /(?:not installed|not found|not available|missing) (?:on|in) (?:this|the|your)/i,
  /(?:command|binary|tool|package) (?:not found|missing)/i,
];

// ─── Domain Classification ──────────────────────────────────────────────

function classifyDomain(tool: string | null, text: string): string {
  const combined = `${tool || ""} ${text}`.toLowerCase();
  if (/exec|ssh|docker|server|deploy|systemctl/.test(combined)) return "operations";
  if (/monitor|hashrate|health|status|check/.test(combined)) return "monitoring";
  if (/message|notify|send|channel|telegram|slack/.test(combined)) return "communication";
  if (/network|vpn|dns|firewall|unifi/.test(combined)) return "infrastructure";
  if (/code|write|edit|debug|build|git/.test(combined)) return "development";
  return "analysis";
}

// ─── Detection ──────────────────────────────────────────────────────────

interface PatternEntry {
  ts: string;
  tool?: string;
  type?: string;
  session?: string;
  result_summary?: string;
  args_summary?: string;
  text_fragment?: string;
  [key: string]: unknown;
}

export function detectBehaviorGaps(): BehaviorGap[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  // Audit fix: use cached read
  return readPatternsCached();
  if (!content.trim()) return [];

  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days
  const gaps: BehaviorGap[] = [];

  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as PatternEntry;
      if (new Date(entry.ts).getTime() < cutoff) continue;

      const textToCheck = [
        entry.result_summary || "",
        entry.text_fragment || "",
      ].join(" ");

      if (!textToCheck.trim()) continue;

      // Check each pattern category
      for (const pattern of FALLBACK_PATTERNS) {
        if (pattern.test(textToCheck)) {
          gaps.push({
            type: "fallback",
            tool: entry.tool || null,
            session: entry.session as string || null,
            text: textToCheck.slice(0, 120),
            ts: entry.ts,
            domain: classifyDomain(entry.tool || null, textToCheck),
          });
          break;
        }
      }

      for (const pattern of DEFERRAL_PATTERNS) {
        if (pattern.test(textToCheck)) {
          gaps.push({
            type: "deferral",
            tool: entry.tool || null,
            session: entry.session as string || null,
            text: textToCheck.slice(0, 120),
            ts: entry.ts,
            domain: classifyDomain(entry.tool || null, textToCheck),
          });
          break;
        }
      }

      for (const pattern of UNCERTAINTY_PATTERNS) {
        if (pattern.test(textToCheck)) {
          gaps.push({
            type: "uncertainty",
            tool: entry.tool || null,
            session: entry.session as string || null,
            text: textToCheck.slice(0, 120),
            ts: entry.ts,
            domain: classifyDomain(entry.tool || null, textToCheck),
          });
          break;
        }
      }

      for (const pattern of INFRASTRUCTURE_PATTERNS) {
        if (pattern.test(textToCheck)) {
          gaps.push({
            type: "infrastructure",
            tool: entry.tool || null,
            session: entry.session as string || null,
            text: textToCheck.slice(0, 120),
            ts: entry.ts,
            domain: classifyDomain(entry.tool || null, textToCheck),
          });
          break;
        }
      }
    } catch { /* skip malformed */ }
  }

  return gaps;
}

// ─── Summarize & Update Tree ────────────────────────────────────────────

export function summarizeBehaviorGaps(): GapSummary[] {
  const gaps = detectBehaviorGaps();
  if (gaps.length === 0) return [];

  // Group by domain + type
  const groups = new Map<string, BehaviorGap[]>();
  for (const gap of gaps) {
    const key = `${gap.domain}:${gap.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(gap);
  }

  const summaries: GapSummary[] = [];
  for (const [key, gapList] of groups) {
    const [domain, gapType] = key.split(":");
    const suggestedActions: Record<string, string> = {
      fallback: `Create skills for ${domain} to handle tasks the agent currently can't perform`,
      deferral: `Create proactive skills that execute automatically instead of asking for permission`,
      uncertainty: `Create skills with explicit verification steps to reduce uncertainty`,
      infrastructure: `Document required tools/access in skills or create setup-verification skills`,
    };

    summaries.push({
      domain,
      gapType,
      count: gapList.length,
      examples: gapList.slice(0, 3).map(g => g.text.slice(0, 80)),
      suggestedAction: suggestedActions[gapType] || `Address ${gapType} gaps in ${domain}`,
    });
  }

  summaries.sort((a, b) => b.count - a.count);
  return summaries;
}

// ─── Update Capability Tree with Behavior Gaps ──────────────────────────

export function updateTreeWithBehaviorGaps(): CapabilityTree {
  const gaps = detectBehaviorGaps();
  const tree = buildCapabilityTree();

  // Count behavior gaps per domain
  const domainGapCounts = new Map<string, number>();
  for (const gap of gaps) {
    domainGapCounts.set(gap.domain, (domainGapCounts.get(gap.domain) || 0) + 1);
  }

  // Adjust gap scores based on behavior patterns
  for (const [domain, node] of Object.entries(tree.domains)) {
    const behaviorGaps = domainGapCounts.get(domain) || 0;
    if (behaviorGaps > 0) {
      // Blend behavior gaps into existing gap score (30% weight for behavior patterns)
      const behaviorGapRate = Math.min(1.0, behaviorGaps / Math.max(node.totalEvents, 10));
      node.gapScore = Math.min(1.0, Math.round((0.7 * node.gapScore + 0.3 * behaviorGapRate) * 100) / 100);
    }
  }

  // Add new domains from behavior gaps that aren't in the tree yet
  for (const [domain, count] of domainGapCounts) {
    if (!tree.domains[domain]) {
      tree.domains[domain] = {
        skills: [],
        totalActivations: 0,
        successRate: 0,
        gapScore: Math.min(1.0, count / 10),
        fallbackEvents: count,
        totalEvents: count,
      };
    }
  }

  return tree;
}

// ─── Format for Display ─────────────────────────────────────────────────

export function formatBehaviorGapReport(): string {
  const summaries = summarizeBehaviorGaps();
  if (summaries.length === 0) {
    return "No behavior gaps detected in the last 14 days. Agent is handling tasks autonomously.";
  }

  let text = `Proactive Gap Analysis\n\n`;
  text += `${summaries.length} gap pattern(s) detected:\n\n`;

  for (const s of summaries) {
    const icon = s.gapType === "fallback" ? "🔴" :
                 s.gapType === "deferral" ? "🟡" :
                 s.gapType === "uncertainty" ? "🟠" : "🔵";
    text += `${icon} ${s.domain.toUpperCase()} — ${s.gapType} (${s.count}x)\n`;
    text += `  Action: ${s.suggestedAction}\n`;
    if (s.examples.length > 0) {
      text += `  Examples:\n`;
      for (const ex of s.examples) {
        text += `    "${ex}"\n`;
      }
    }
    text += `\n`;
  }

  return text;
}
