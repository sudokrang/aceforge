/**
 * Capability Tree — Phase 2A
 *
 * Organizes skills into a hierarchical capability tree with gap scoring per domain.
 * Gap score = fallback_events / total_events. High gap = priority target for skill generation.
 *
 * Research: AgentSkillOS (arXiv:2603.02176) — recursive categorization into capability tree;
 * tree-based retrieval effectively approximates oracle skill selection at 200K+ skills.
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { getHealthEntries, listActiveSkills, getSkillStats } from "../skill/lifecycle.js";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
const TREE_FILE = path.join(FORGE_DIR, "capability-tree.json");

// ─── Types ──────────────────────────────────────────────────────────────

export interface TreeNode {
  skills: string[];
  totalActivations: number;
  successRate: number;
  gapScore: number;
  fallbackEvents: number;
  totalEvents: number;
  children?: Record<string, TreeNode>;
}

export interface CapabilityTree {
  version: number;
  updated: string;
  domains: Record<string, TreeNode>;
}

// ─── Domain Classification ──────────────────────────────────────────────

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  operations: ["exec", "ssh", "scp", "rsync", "deploy", "server", "docker", "systemctl", "service", "restart", "netsuite", "production", "schedule"],
  monitoring: ["hashrate", "health", "status", "check", "monitor", "uptime", "bitaxe", "mammoth", "temperature", "disk", "usage"],
  communication: ["message", "notify", "digest", "format", "channel", "telegram", "slack", "discord", "email", "send"],
  infrastructure: ["unifi", "network", "vpn", "dns", "ssl", "cert", "firewall", "port", "router", "nas", "synology", "docker-compose"],
  development: ["code", "write", "edit", "debug", "fix", "build", "compile", "test", "git", "commit", "push", "pull"],
  analysis: ["read", "parse", "extract", "search", "query", "analyze", "report", "csv", "excel", "pdf", "data"],
};

function classifyDomain(skillName: string, description: string): string {
  const text = `${skillName} ${description}`.toLowerCase();
  let bestDomain = "analysis"; // default
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestDomain;
}

function getSkillCategory(skillName: string): string {
  const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
  if (!fsSync.existsSync(skillFile)) return "analysis";

  try {
    const content = fsSync.readFileSync(skillFile, "utf-8");
    const nestedMatch = content.match(/^\s*metadata:\s*\n\s+openclaw:\s*\n\s+category:\s*(\w+)/mi);
    if (nestedMatch) return nestedMatch[1].toLowerCase();
    const flatMatch = content.match(/^\s*category:\s*(\w+)/mi);
    if (flatMatch) return flatMatch[1].toLowerCase();

    const descMatch = content.match(/^description:\s*["']?(.+?)["']?$/m);
    if (descMatch) return classifyDomain(skillName, descMatch[1]);
  } catch { /* fallback */ }
  return classifyDomain(skillName, "");
}

// ─── Fallback/Deferral Event Counting ───────────────────────────────────

interface PatternEntry {
  ts: string;
  tool: string;
  type?: string;
  success: boolean;
  session?: string;
  args_summary?: string;
  result_summary?: string;
  error?: string;
  [key: string]: unknown;
}

function loadRecentPatterns(daysCutoff: number = 30): PatternEntry[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];

  const cutoff = Date.now() - daysCutoff * 24 * 60 * 60 * 1000;
  return content.trim().split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l) as PatternEntry; } catch { return null; } })
    .filter(Boolean)
    .filter(p => new Date(p!.ts).getTime() >= cutoff) as PatternEntry[];
}

function countDomainEvents(patterns: PatternEntry[], domainSkills: string[]): { total: number; fallbacks: number } {
  let total = 0;
  let fallbacks = 0;

  for (const p of patterns) {
    if (p.type === "correction" || p.type === "chain") continue;
    // Check if this tool is associated with a skill in this domain
    const isInDomain = domainSkills.some(s => {
      const prefix = s.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
      return prefix === p.tool || s === p.tool;
    });
    if (!isInDomain) continue;
    total++;
    if (!p.success) fallbacks++;
  }

  return { total, fallbacks };
}

// ─── Gap Event Detection (fallback/deferral patterns) ───────────────────

function countFallbackPatterns(patterns: PatternEntry[]): Map<string, number> {
  const domainFallbacks = new Map<string, number>();

  // Check for tool failures by domain
  for (const p of patterns) {
    if (p.type === "correction" || p.type === "chain") continue;
    if (!p.success && p.tool) {
      const domain = classifyDomain(p.tool, p.args_summary || "");
      domainFallbacks.set(domain, (domainFallbacks.get(domain) || 0) + 1);
    }
  }

  // Check for deferral/fallback text patterns in corrections
  const deferrals = patterns.filter(p => p.type === "correction");
  for (const d of deferrals) {
    const text = (d.text_fragment || "").toLowerCase();
    const isDeferral = /can't do that|you'll need to|manually|let me know if|i'm not sure|not able to/i.test(text);
    if (isDeferral) {
      // Associate with nearest tool call
      const nearbyTool = patterns.find(p =>
        p.type !== "correction" && p.session === d.session && p.tool &&
        Math.abs(new Date(p.ts).getTime() - new Date(d.ts).getTime()) < 120000
      );
      if (nearbyTool) {
        const domain = classifyDomain(nearbyTool.tool, nearbyTool.args_summary || "");
        domainFallbacks.set(domain, (domainFallbacks.get(domain) || 0) + 1);
      }
    }
  }

  return domainFallbacks;
}

// ─── Build the Tree ─────────────────────────────────────────────────────

export function buildCapabilityTree(): CapabilityTree {
  const activeSkills = listActiveSkills();
  const patterns = loadRecentPatterns(30);
  const domainFallbacks = countFallbackPatterns(patterns);

  // Group skills by domain
  const domainSkills = new Map<string, string[]>();
  for (const skill of activeSkills) {
    const domain = getSkillCategory(skill);
    if (!domainSkills.has(domain)) domainSkills.set(domain, []);
    domainSkills.get(domain)!.push(skill);
  }

  // Also create entries for domains with patterns but no skills
  for (const p of patterns) {
    if (p.type === "correction" || p.type === "chain" || !p.tool) continue;
    const domain = classifyDomain(p.tool, p.args_summary || "");
    if (!domainSkills.has(domain)) domainSkills.set(domain, []);
  }

  // Build domain nodes
  const domains: Record<string, TreeNode> = {};

  for (const [domain, skills] of domainSkills) {
    let totalActivations = 0;
    let totalSuccesses = 0;

    for (const skill of skills) {
      const stats = getSkillStats(skill);
      totalActivations += stats.activations;
      totalSuccesses += Math.round(stats.successRate * stats.activations);
    }

    // Count domain-level events from patterns
    const events = countDomainEvents(patterns, skills);
    const fallbacks = domainFallbacks.get(domain) || 0;
    const totalDomainEvents = Math.max(events.total, 1); // prevent div/0

    // Gap score: proportion of events that were failures or fallbacks
    const gapScore = Math.round(((events.fallbacks + fallbacks) / totalDomainEvents) * 100) / 100;

    domains[domain] = {
      skills,
      totalActivations,
      successRate: totalActivations > 0 ? Math.round((totalSuccesses / totalActivations) * 100) / 100 : 0,
      gapScore: Math.min(1.0, gapScore),
      fallbackEvents: events.fallbacks + fallbacks,
      totalEvents: totalDomainEvents,
    };
  }

  const tree: CapabilityTree = {
    version: 1,
    updated: new Date().toISOString(),
    domains,
  };

  // Persist to disk
  try {
    fsSync.writeFileSync(TREE_FILE, JSON.stringify(tree, null, 2), "utf-8");
  } catch (err) {
    console.error(`[aceforge/tree] Failed to write capability tree: ${(err as Error).message}`);
  }

  return tree;
}

// ─── Load from Disk ─────────────────────────────────────────────────────

export function loadCapabilityTree(): CapabilityTree | null {
  try {
    if (!fsSync.existsSync(TREE_FILE)) return null;
    const content = fsSync.readFileSync(TREE_FILE, "utf-8");
    return JSON.parse(content) as CapabilityTree;
  } catch {
    return null;
  }
}

// ─── Get Priority Domains ───────────────────────────────────────────────

export function getPriorityDomains(threshold: number = 0.4): Array<{ domain: string; gapScore: number; skills: string[] }> {
  const tree = loadCapabilityTree() || buildCapabilityTree();
  return Object.entries(tree.domains)
    .filter(([, node]) => node.gapScore >= threshold)
    .sort(([, a], [, b]) => b.gapScore - a.gapScore)
    .map(([domain, node]) => ({
      domain,
      gapScore: node.gapScore,
      skills: node.skills,
    }));
}

// ─── Format for Display ─────────────────────────────────────────────────

export function formatCapabilityTree(): string {
  const tree = loadCapabilityTree() || buildCapabilityTree();
  let text = `Capability Tree (updated: ${new Date(tree.updated).toLocaleString()})\n\n`;

  const sorted = Object.entries(tree.domains).sort(([, a], [, b]) => b.gapScore - a.gapScore);

  for (const [domain, node] of sorted) {
    const gapIndicator = node.gapScore >= 0.6 ? "🔴" : node.gapScore >= 0.3 ? "🟡" : "🟢";
    text += `${gapIndicator} ${domain.toUpperCase()} — gap: ${Math.round(node.gapScore * 100)}%\n`;
    text += `  Skills: ${node.skills.length > 0 ? node.skills.join(", ") : "none"}\n`;
    text += `  Activations: ${node.totalActivations} | Success: ${Math.round(node.successRate * 100)}%\n`;
    text += `  Events: ${node.totalEvents} total, ${node.fallbackEvents} failures/fallbacks\n\n`;
  }

  const priority = sorted.filter(([, n]) => n.gapScore >= 0.4);
  if (priority.length > 0) {
    text += `Priority targets for skill generation:\n`;
    for (const [domain, node] of priority) {
      text += `  → ${domain}: ${Math.round(node.gapScore * 100)}% gap score\n`;
    }
  }

  return text;
}
