/**
 * Skill Version History — AceForge
 *
 * Tracks every mutation to a deployed SKILL.md:
 *   deploy, micro-revision, upgrade, rollback, retire, reinstate
 *
 * Full previous content stored per version (not just diffs) so any past
 * version can be reconstructed for rollback. Diffs computed at display time.
 *
 * Diff algorithm: LCS (Longest Common Subsequence) via standard DP.
 * O(n*m) time and space — trivial for skills capped at 500 lines.
 * Zero external dependencies.
 *
 * Storage: skills/{name}/.history.jsonl (travels with skill on retire/reinstate)
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
const RETIRED_DIR = path.join(HOME, ".openclaw", "workspace", ".forge", "retired");

// ─── Types ──────────────────────────────────────────────────────────────

export interface HistoryEntry {
  v: number;
  ts: string;
  action: "deploy" | "micro-revision" | "upgrade" | "rollback" | "retire" | "reinstate";
  reason: string;
  md: string;
}

// ─── Core API ───────────────────────────────────────────────────────────

export function recordRevision(
  skillName: string,
  md: string,
  action: HistoryEntry["action"],
  reason: string
): void {
  const historyFile = resolveHistoryFile(skillName);
  if (!historyFile) return;

  const nextVersion = getLatestVersion(skillName) + 1;
  const entry: HistoryEntry = {
    v: nextVersion,
    ts: new Date().toISOString(),
    action,
    reason: reason.slice(0, 500),
    md,
  };

  try {
    fsSync.appendFileSync(historyFile, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[aceforge/history] Failed to record revision for ${skillName}: ${(err as Error).message}`);
  }
}

export function getHistory(skillName: string): HistoryEntry[] {
  const historyFile = resolveHistoryFile(skillName);
  if (!historyFile || !fsSync.existsSync(historyFile)) return [];

  try {
    const content = fsSync.readFileSync(historyFile, "utf-8").trim();
    if (!content) return [];
    return content.split("\n")
      .filter(line => line.trim().length > 0)
      .map(line => { try { return JSON.parse(line) as HistoryEntry; } catch { return null; } })
      .filter(Boolean) as HistoryEntry[];
  } catch {
    return [];
  }
}

export function getLatestVersion(skillName: string): number {
  const entries = getHistory(skillName);
  if (entries.length === 0) return 0;
  return Math.max(...entries.map(e => e.v));
}

// ─── Diff Engine (LCS-based, zero dependencies) ────────────────────────

export function computeLineDiff(oldMd: string, newMd: string, contextLines: number = 3): string {
  if (oldMd === newMd) return "(no changes)";

  const oldLines = oldMd.split("\n");
  const newLines = newMd.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce edit script
  const ops: Array<{ type: "eq" | "del" | "ins"; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "eq", line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "ins", line: newLines[j - 1] });
      j--;
    } else {
      ops.push({ type: "del", line: oldLines[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Format as unified diff hunks
  const output: string[] = [];
  const changes: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== "eq") changes.push(k);
  }
  if (changes.length === 0) return "(no changes)";

  // Group changes into hunks
  const hunks: number[][] = [];
  let currentHunk: number[] = [changes[0]];
  for (let c = 1; c < changes.length; c++) {
    if (changes[c] - changes[c - 1] <= contextLines * 2 + 1) {
      currentHunk.push(changes[c]);
    } else {
      hunks.push(currentHunk);
      currentHunk = [changes[c]];
    }
  }
  hunks.push(currentHunk);

  // Render each hunk
  for (const hunk of hunks) {
    const firstChange = hunk[0];
    const lastChange = hunk[hunk.length - 1];
    const start = Math.max(0, firstChange - contextLines);
    const end = Math.min(ops.length - 1, lastChange + contextLines);

    // Count old/new lines for header
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k].type !== "ins") oldStart++;
      if (ops[k].type !== "del") newStart++;
    }
    let oldCount = 0, newCount = 0;
    const hunkLines: string[] = [];
    for (let k = start; k <= end; k++) {
      const op = ops[k];
      if (op.type === "eq") {
        hunkLines.push(` ${op.line}`);
        oldCount++; newCount++;
      } else if (op.type === "del") {
        hunkLines.push(`-${op.line}`);
        oldCount++;
      } else {
        hunkLines.push(`+${op.line}`);
        newCount++;
      }
    }
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    output.push(...hunkLines);
  }

  const adds = ops.filter(o => o.type === "ins").length;
  const dels = ops.filter(o => o.type === "del").length;
  return `${adds} addition(s), ${dels} deletion(s)\n\n${output.join("\n")}`;
}

// ─── Display Formatters ─────────────────────────────────────────────────

export function formatHistoryTimeline(skillName: string): string {
  const entries = getHistory(skillName);
  if (entries.length === 0) return `No version history for '${skillName}'.`;

  const icons: Record<string, string> = {
    "deploy": "🟢", "micro-revision": "🔧", "upgrade": "⬆️",
    "rollback": "↩️", "retire": "🛑", "reinstate": "♻️",
  };

  let text = `Version History: ${skillName}\n${entries.length} revision(s)\n\n`;
  for (const e of entries) {
    const icon = icons[e.action] || "○";
    const dateStr = e.ts.slice(0, 16).replace("T", " ");
    const lines = e.md.split("\n").length;
    text += `  ${icon} v${e.v}  ${dateStr}  [${e.action}]  ${lines} lines\n`;
    text += `     ${e.reason.slice(0, 100)}\n`;
  }
  text += `\nUse: /forge diff ${skillName} [version]`;
  return text;
}

export function formatDiff(skillName: string, version?: number): string {
  const entries = getHistory(skillName);
  if (entries.length === 0) return `No version history for '${skillName}'.`;

  const targetVersion = version !== undefined
    ? version
    : Math.max(...entries.map(e => e.v));

  const newEntry = entries.find(e => e.v === targetVersion);
  if (!newEntry) return `Version ${targetVersion} not found for '${skillName}'.`;

  const prevEntry = entries
    .filter(e => e.v < targetVersion)
    .sort((a, b) => b.v - a.v)[0];

  if (!prevEntry) {
    const lines = newEntry.md.split("\n").length;
    return `${skillName} v${targetVersion} (initial — ${newEntry.action})\n` +
      `${lines} lines, no previous version to compare.\n` +
      `Reason: ${newEntry.reason}`;
  }

  const header = `${skillName}: v${prevEntry.v} → v${targetVersion}\n` +
    `Action: ${newEntry.action}\n` +
    `Reason: ${newEntry.reason}\n` +
    `Date: ${newEntry.ts.slice(0, 16).replace("T", " ")}\n\n`;

  return header + computeLineDiff(prevEntry.md, newEntry.md);
}

// ─── Internal ───────────────────────────────────────────────────────────

function resolveHistoryFile(skillName: string): string | null {
  const activeDir = path.join(SKILLS_DIR, skillName);
  if (fsSync.existsSync(activeDir)) return path.join(activeDir, ".history.jsonl");
  const retiredDir = path.join(RETIRED_DIR, skillName);
  if (fsSync.existsSync(retiredDir)) return path.join(retiredDir, ".history.jsonl");
  return null;
}
