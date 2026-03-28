/**
 * Novel One-Shot Success Capture — v0.9.0
 *
 * Detects first-time successful tool usage patterns that wouldn't trigger
 * normal crystallization (threshold 3x+) but represent valuable one-shot
 * knowledge worth preserving.
 *
 * Inspired by Voyager's (arXiv:2305.16291) self-verification before adding
 * skills to library: each captured success is validated for novelty before
 * being queued as a capture candidate.
 *
 * Design constraints (from spec):
 *  - No auto-mutation: captures require human review
 *  - No prestige tiers: capture quality is binary (valid/invalid)
 *  - Human approval gate via `/forge captures` and `/forge approve`
 *
 * What qualifies as "novel one-shot":
 *  1. Tool has no existing deployed skill AND no pending proposal
 *  2. First successful invocation of a distinct arg pattern
 *  3. Success on first attempt (no prior failures for this pattern)
 *  4. Tool is not in any blocklist
 *  5. Result indicates meaningful work (not empty/trivial)
 */

import * as fsSync from "fs";
import * as path from "path";
import { FORGE_DIR, SKILLS_DIR, NATIVE_TOOLS, ACEFORGE_TOOL_BLOCKLIST, PatternEntry } from "../pattern/constants.js";

// ─── Configuration ──────────────────────────────────────────────────────

/** Maximum captures to retain (oldest are rotated out) */
const MAX_CAPTURES = 100;

/** Minimum result size to consider non-trivial */
const MIN_RESULT_LENGTH = 20;

/** Captures file path */
const CAPTURES_FILE = path.join(FORGE_DIR, "captures.jsonl");

// ─── Types ──────────────────────────────────────────────────────────────

export interface CaptureEntry {
  ts: string;
  tool: string;
  args_summary: string;
  result_summary: string;
  session: string | null;
  status: "pending" | "promoted" | "dismissed";
  noveltyReason: string;
}

export interface CaptureCheck {
  novel: boolean;
  reason: string;
}

// ─── Novelty Detection ──────────────────────────────────────────────────

/**
 * Determines whether a successful tool call represents a novel one-shot success.
 *
 * Checks performed (in order, short-circuit on first failure):
 * 1. Tool not blocklisted
 * 2. No existing deployed skill for this tool
 * 3. No pending proposal for this tool
 * 4. Arg pattern not seen before in captures
 * 5. No prior failures for this exact pattern (one-shot = first-try success)
 * 6. Result is non-trivial
 */
export function checkNovelSuccess(
  toolName: string,
  argsSummary: string | null,
  resultSummary: string | null,
  success: boolean,
  session: string | null,
): CaptureCheck {
  // Must be a success
  if (!success) return { novel: false, reason: "not_success" };

  // Check blocklists
  if (ACEFORGE_TOOL_BLOCKLIST.has(toolName)) {
    return { novel: false, reason: "blocklisted_aceforge" };
  }
  if (NATIVE_TOOLS.has(toolName)) {
    return { novel: false, reason: "blocklisted_native" };
  }

  // Check for existing deployed skill
  if (fsSync.existsSync(SKILLS_DIR)) {
    for (const skillName of fsSync.readdirSync(SKILLS_DIR)) {
      try {
        if (!fsSync.statSync(path.join(SKILLS_DIR, skillName)).isDirectory()) continue;
      } catch { continue; }

      // Exact match or prefix match
      if (skillName === toolName || skillName.startsWith(toolName + "-") ||
          toolName.startsWith(skillName + "_") || toolName.startsWith(skillName + "-")) {
        return { novel: false, reason: "skill_exists" };
      }

      // Frontmatter tool field match
      const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
      if (fsSync.existsSync(skillFile)) {
        try {
          const content = fsSync.readFileSync(skillFile, "utf-8");
          const toolMatch = content.match(/^\s*tool:\s*(.+)$/m);
          if (toolMatch && toolMatch[1].trim() === toolName) {
            return { novel: false, reason: "skill_exists" };
          }
        } catch { /* skip */ }
      }
    }
  }

  // Check for pending proposals
  const proposalsDir = path.join(FORGE_DIR, "proposals");
  if (fsSync.existsSync(proposalsDir)) {
    for (const propName of fsSync.readdirSync(proposalsDir)) {
      if (propName === toolName || propName.startsWith(toolName + "-")) {
        return { novel: false, reason: "proposal_pending" };
      }
    }
  }

  // Check result is non-trivial
  if (!resultSummary || resultSummary.length < MIN_RESULT_LENGTH) {
    return { novel: false, reason: "trivial_result" };
  }

  // Normalize arg pattern for comparison
  const normalizedArgs = normalizeArgPattern(argsSummary);

  // Check if this arg pattern was already captured
  if (fsSync.existsSync(CAPTURES_FILE)) {
    const content = fsSync.readFileSync(CAPTURES_FILE, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CaptureEntry;
        if (entry.tool === toolName && normalizeArgPattern(entry.args_summary) === normalizedArgs) {
          return { novel: false, reason: "already_captured" };
        }
      } catch { /* skip */ }
    }
  }

  // Check for prior failures with this pattern (one-shot = first-try success)
  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  if (fsSync.existsSync(patternsFile)) {
    const content = fsSync.readFileSync(patternsFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as PatternEntry;
        if (
          entry.tool === toolName &&
          !entry.success &&
          normalizeArgPattern(entry.args_summary) === normalizedArgs
        ) {
          return { novel: false, reason: "prior_failure" };
        }
      } catch { /* skip */ }
    }
  }

  return { novel: true, reason: "novel_one_shot" };
}

// ─── Arg Normalization ──────────────────────────────────────────────────

function normalizeArgPattern(argsSummary: string | null): string {
  if (!argsSummary) return "(no_args)";
  return argsSummary
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/\/[^\s"',}]{10,}/g, "<path>")
    .replace(/\d{5,}/g, "<num>")
    .slice(0, 80);
}

// ─── Capture Recording ──────────────────────────────────────────────────

/**
 * Records a novel one-shot success to captures.jsonl.
 * Rotates captures if MAX_CAPTURES is exceeded.
 */
export function recordCapture(
  toolName: string,
  argsSummary: string | null,
  resultSummary: string | null,
  session: string | null,
  noveltyReason: string,
): void {
  fsSync.mkdirSync(path.dirname(CAPTURES_FILE), { recursive: true });

  const entry: CaptureEntry = {
    ts: new Date().toISOString(),
    tool: toolName,
    args_summary: argsSummary || "",
    result_summary: resultSummary || "",
    session,
    status: "pending",
    noveltyReason,
  };

  fsSync.appendFileSync(CAPTURES_FILE, JSON.stringify(entry) + "\n");

  // Rotate if needed
  rotateCapturesIfNeeded();
}

function rotateCapturesIfNeeded(): void {
  if (!fsSync.existsSync(CAPTURES_FILE)) return;

  const content = fsSync.readFileSync(CAPTURES_FILE, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  if (lines.length <= MAX_CAPTURES) return;

  // Keep only the most recent MAX_CAPTURES entries
  const kept = lines.slice(lines.length - MAX_CAPTURES);
  fsSync.writeFileSync(CAPTURES_FILE, kept.join("\n") + "\n");
}

// ─── Capture Promotion ──────────────────────────────────────────────────

/**
 * Marks a capture as promoted — its tool will be added to the
 * generation candidate pool at a lower threshold (1x instead of 3x).
 */
export function promoteCapture(toolName: string): boolean {
  if (!fsSync.existsSync(CAPTURES_FILE)) return false;

  const content = fsSync.readFileSync(CAPTURES_FILE, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  let found = false;

  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line) as CaptureEntry;
      if (entry.tool === toolName && entry.status === "pending") {
        entry.status = "promoted";
        found = true;
        return JSON.stringify(entry);
      }
    } catch { /* skip */ }
    return line;
  });

  if (found) {
    fsSync.writeFileSync(CAPTURES_FILE, updated.join("\n") + "\n");
  }
  return found;
}

/**
 * Dismisses a capture — marks it as not worth pursuing.
 */
export function dismissCapture(toolName: string): boolean {
  if (!fsSync.existsSync(CAPTURES_FILE)) return false;

  const content = fsSync.readFileSync(CAPTURES_FILE, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  let found = false;

  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line) as CaptureEntry;
      if (entry.tool === toolName && entry.status === "pending") {
        entry.status = "dismissed";
        found = true;
        return JSON.stringify(entry);
      }
    } catch { /* skip */ }
    return line;
  });

  if (found) {
    fsSync.writeFileSync(CAPTURES_FILE, updated.join("\n") + "\n");
  }
  return found;
}

// ─── Capture Listing ────────────────────────────────────────────────────

export function listCaptures(statusFilter?: "pending" | "promoted" | "dismissed"): CaptureEntry[] {
  if (!fsSync.existsSync(CAPTURES_FILE)) return [];

  const content = fsSync.readFileSync(CAPTURES_FILE, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  const entries: CaptureEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CaptureEntry;
      if (!statusFilter || entry.status === statusFilter) {
        entries.push(entry);
      }
    } catch { /* skip */ }
  }

  return entries;
}

// ─── Format captures for /forge captures command ────────────────────────

export function formatCapturesReport(): string {
  const pending = listCaptures("pending");
  const promoted = listCaptures("promoted");

  if (pending.length === 0 && promoted.length === 0) {
    return "No captured novel successes.\n\nCapture mode detects first-time successful tool usage patterns " +
      "that could become skills. These appear automatically as your agent encounters new tools.";
  }

  const lines: string[] = [];
  lines.push(`Novel Success Captures\n`);

  if (pending.length > 0) {
    lines.push(`Pending (${pending.length}):`);
    // Group by tool
    const byTool = new Map<string, CaptureEntry[]>();
    for (const c of pending) {
      const group = byTool.get(c.tool) || [];
      group.push(c);
      byTool.set(c.tool, group);
    }

    for (const [tool, entries] of byTool) {
      const latest = entries[entries.length - 1];
      lines.push(`  ◌ ${tool} — ${entries.length} capture(s)`);
      lines.push(`    Last: ${latest.args_summary.slice(0, 60) || "(no args)"}`);
      lines.push(`    /forge capture promote ${tool}  │  /forge capture dismiss ${tool}`);
    }
  }

  if (promoted.length > 0) {
    lines.push(``);
    lines.push(`Promoted (${promoted.length}):`);
    const byTool = new Map<string, number>();
    for (const c of promoted) {
      byTool.set(c.tool, (byTool.get(c.tool) || 0) + 1);
    }
    for (const [tool, count] of byTool) {
      lines.push(`  ✓ ${tool} — ${count} capture(s), awaiting crystallization`);
    }
  }

  return lines.join("\n");
}
