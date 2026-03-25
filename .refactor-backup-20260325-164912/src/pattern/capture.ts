/**
 * Tool trace capture — logs to patterns.jsonl and tracks skill activations
 *
 * v0.6.0 fixes:
 *  - M4: resolveSkillActivation matches via skill name prefix, not full-text regex
 *  - L4: chain detection preserves last 2 entries for overlapping chain detection
 *  - G7: session tool history persisted to disk — chain detection survives restarts
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { appendJsonl } from "./store.js";
import {
  recordActivation,
  checkAndTriggerRevision,
  recordVerification,
  checkVerification,
  checkEffectivenessVsBaseline,
  getSkillStats,
} from "../skill/lifecycle.js";
import { notify } from "../notify.js";

const HOME = os.homedir() || process.env.HOME || "";

const SKILLS_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "skills"
);

const FORGE_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  ".forge"
);

// M5 fix: module-scope blocklist (was recreated on every tool call)
const CAPTURE_BLOCKLIST = new Set([
  "forge", "forge_status", "forge_reflect", "forge_propose",
  "forge_approve_skill", "forge_reject_skill", "forge_approve", "forge_reject",
  "forge_quality", "forge_registry", "forge_rewards", "forge_gaps",
  "forge_retire", "forge_retire_skill", "forge_reinstate",
  "forge_tree", "forge_cross_session", "forge_compose",
  "forge_behavior_gaps", "forge_optimize",
  "forge_test", "forge_challenge", "forge_adversarial",
  "sessions_spawn", "sessions_list", "sessions_send", "sessions_history",
]);

const SESSION_HISTORY_FILE = path.join(FORGE_DIR, "session-history.json");

// Track recent tool calls per session for chain detection
const sessionToolHistory = new Map<string, { tool: string; ts: number }[]>();
const CHAIN_WINDOW_MS = 60000;
const CHAIN_MIN_LENGTH = 3;

// ─── G7: Persist session history to disk ────────────────────────
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 2000;

function hydrateSessionHistory(): void {
  try {
    if (!fsSync.existsSync(SESSION_HISTORY_FILE)) return;
    const raw = fsSync.readFileSync(SESSION_HISTORY_FILE, "utf-8");
    if (!raw.trim()) return;
    const data = JSON.parse(raw) as Record<string, { tool: string; ts: number }[]>;
    const now = Date.now();
    for (const [key, entries] of Object.entries(data)) {
      // Only restore entries within the chain window
      const fresh = entries.filter(e => now - e.ts < CHAIN_WINDOW_MS);
      if (fresh.length > 0) sessionToolHistory.set(key, fresh);
    }
    console.log(`[aceforge] restored session history: ${sessionToolHistory.size} sessions`);
  } catch (err) {
    console.warn(`[aceforge] failed to restore session history: ${(err as Error).message}`);
  }
}

function flushSessionHistory(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    try {
      // Audit fix: prune sessions with no entries in the last 10 minutes
      const PRUNE_MS = 10 * 60 * 1000;
      const now = Date.now();
      for (const [key, entries] of sessionToolHistory) {
        if (entries.length === 0 || now - entries[entries.length - 1].ts > PRUNE_MS) {
          sessionToolHistory.delete(key);
        }
      }

      const obj: Record<string, { tool: string; ts: number }[]> = {};
      for (const [key, entries] of sessionToolHistory) {
        if (entries.length > 0) obj[key] = entries;
      }
      fsSync.writeFileSync(SESSION_HISTORY_FILE, JSON.stringify(obj), "utf-8");
    } catch (err) {
      console.warn(`[aceforge] failed to flush session history: ${(err as Error).message}`);
    }
  }, FLUSH_DEBOUNCE_MS);
}

// Hydrate on module load
hydrateSessionHistory();

/**
 * M4 fix: Match skill activation via name prefix or explicit tool metadata,
 * not a full-text regex that matches any mention of the tool name.
 */
function resolveSkillActivation(toolName: string, _argsSummary: string | null): string | null {
  if (!fsSync.existsSync(SKILLS_DIR)) return null;

  for (const skillName of fsSync.readdirSync(SKILLS_DIR)) {
    const skillDir = path.join(SKILLS_DIR, skillName);
    try {
      if (!fsSync.statSync(skillDir).isDirectory()) continue;
    } catch { continue; }

    // Match 1: exact name match (skill "tavily" matches tool "tavily")
    if (skillName === toolName) return skillName;

    // Match 2: skill name starts with tool name + dash (forward match)
    // "read-code" starts with "read-" → matches tool "read"
    // "exec-openclaw" starts with "exec-" → matches tool "exec"
    if (skillName.startsWith(toolName + "-")) return skillName;

    // Match 3: tool name starts with skill name + separator (reverse match)
    // tool "tavily_search" starts with "tavily" + "_" → matches skill "tavily"
    // tool "tavily_extract" starts with "tavily" + "_" → matches skill "tavily"
    if (toolName.startsWith(skillName + "_") || toolName.startsWith(skillName + "-")) return skillName;

    // Match 4: explicit tool metadata in frontmatter
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fsSync.existsSync(skillFile)) continue;

    try {
      const content = fsSync.readFileSync(skillFile, "utf-8");
      const toolMatch = content.match(/^\s*tool:\s*(.+)$/m);
      if (toolMatch && toolMatch[1].trim() === toolName) return skillName;

      // Match 5: bundledTools list in frontmatter
      const bundledMatch = content.match(/bundledTools:\s*\[([^\]]+)\]/);
      if (bundledMatch) {
        const tools = bundledMatch[1].split(",").map(t => t.trim().replace(/['"]/g, ""));
        if (tools.includes(toolName)) return skillName;
      }

      // Match 6: multi-line bundledTools YAML array
      const multiMatch = content.match(/bundledTools:\s*\n((?:\s+-\s+\S+\n?)+)/);
      if (multiMatch) {
        const tools = multiMatch[1].split("\n")
          .map(l => l.replace(/^\s*-\s*/, "").trim().replace(/['"]/g, ""))
          .filter(Boolean);
        if (tools.includes(toolName)) return skillName;
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

export function captureToolTrace(event: any, ctx: any, api?: any): void {
  if (api?.logger) {
    api.logger.info(`[aceforge] tool: ${event?.toolName}`);
  }

  try {
    const ev = event as any;
    const cx = ctx as any;

    // Skip AceForge and session-management tools
    if (CAPTURE_BLOCKLIST.has(ev?.toolName)) return;

    appendJsonl("patterns.jsonl", {
      ts: new Date().toISOString(),
      tool: ev?.toolName ?? null,
      args_summary: ev?.params ? JSON.stringify(ev.params).slice(0, 100) : null,
      result_summary: ev?.result != null ? JSON.stringify(ev.result).slice(0, 200) : null,
      success: !ev?.error,
      session: cx?.sessionKey ?? null,
      runId: ev?.runId ?? null,
      toolCallId: ev?.toolCallId ?? null,
      error: ev?.error ?? null,
      durationMs: ev?.durationMs ?? null,
    });

    // ── Chain detection ──────────────────────────────────────────
    const sessionKey = cx?.sessionKey || "_unknown";
    if (!sessionToolHistory.has(sessionKey)) sessionToolHistory.set(sessionKey, []);
    const history = sessionToolHistory.get(sessionKey)!;
    const now = Date.now();
    history.push({ tool: ev?.toolName || "?", ts: now });

    // Prune entries older than the chain window
    while (history.length > 0 && now - history[0].ts > CHAIN_WINDOW_MS) history.shift();

    // If 3+ distinct tools in window, log chain with sequence detail
    if (history.length >= CHAIN_MIN_LENGTH) {
      const distinctTools = [...new Set(history.map(h => h.tool))];
      if (distinctTools.length >= CHAIN_MIN_LENGTH) {
        const orderedTools: string[] = [];
        const seenInChain = new Set<string>();
        for (const h of history) {
          if (!seenInChain.has(h.tool)) {
            orderedTools.push(h.tool);
            seenInChain.add(h.tool);
          }
        }
        appendJsonl("patterns.jsonl", {
          ts: new Date().toISOString(),
          type: "chain",
          tools: orderedTools,
          tool_sequence: history.map(h => h.tool),
          session: sessionKey,
          window_ms: now - history[0].ts,
          step_count: history.length,
        });
        // L4 fix: keep last 2 entries for overlapping chain detection
        const lastTwo = history.slice(-2);
        history.length = 0;
        history.push(...lastTwo);
      }
    }

    // G7: debounced persist after every chain-history mutation
    flushSessionHistory();

    // ── Skill activation tracking ────────────────────────────────
    if (ev?.toolName) {
      const argsSummary = ev?.params ? JSON.stringify(ev.params).slice(0, 100) : null;
      const matchedSkill = resolveSkillActivation(ev.toolName, argsSummary);
      if (matchedSkill) {
        const success = !ev?.error;
        recordActivation(matchedSkill, success);

        // Effectiveness check at 50-activation milestones
        const stats = getSkillStats(matchedSkill);
        if (stats.activations > 0 && stats.activations % 50 === 0) {
          const effectiveness = checkEffectivenessVsBaseline(matchedSkill);
          if (effectiveness) {
            const direction = effectiveness.delta >= 0 ? "+" : "";
            notify(
              "Skill Effectiveness Report\n" +
              matchedSkill + "\n" +
              (effectiveness.improved ? "Improved" : "Declined") + ": " + direction + effectiveness.delta + "% since deployment\n" +
              stats.activations + " activations, " + Math.round(stats.successRate * 100) + "% success"
            ).catch(() => {});
          }
        }

        // Failure-driven revision
        if (!success) {
          checkAndTriggerRevision(matchedSkill);
        }

        // Verification loop
        const resultSummary = ev?.result != null ? JSON.stringify(ev.result).slice(0, 200) : "";
        recordVerification(matchedSkill, success, resultSummary);
        if (checkVerification(matchedSkill) === false) {
          checkAndTriggerRevision(matchedSkill);
        }

        if (api?.logger) {
          api.logger.info(`[aceforge] skill activation: ${matchedSkill} (via ${ev.toolName})`);
        }
      } else {
        recordActivation(`_unmanaged:${ev.toolName}`, !ev?.error);
      }
    }
  } catch (err) {
    if (api?.logger) {
      api.logger.error(`[aceforge] capture error: ${(err as Error).message}`);
    } else {
      console.error("[aceforge] captureToolTrace error:", err);
    }
  }
}
