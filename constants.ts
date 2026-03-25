/**
 * AceForge Shared Constants — Canonical Blocklists & Types
 *
 * v0.8.1: Extracted from analyze.ts, capture.ts, cross-session.ts, gap-detect.ts.
 * This is the SINGLE SOURCE OF TRUTH for all tool blocklists.
 * Every other file imports from here. No more drift.
 *
 * If you add a tool to any blocklist, add it HERE. The test suite
 * verifies no other file defines its own blocklist.
 */
import * as os from "os";
import * as path from "path";

// ─── Paths ──────────────────────────────────────────────────────────────

export const HOME = os.homedir() || process.env.HOME || "";
export const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
export const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
export const PROPOSALS_DIR = path.join(FORGE_DIR, "proposals");

// ─── Shared Types ───────────────────────────────────────────────────────

export interface PatternEntry {
  ts: string;
  tool: string;
  args_summary: string | null;
  success: boolean;
  session: string | null;
  type?: string;
  result_summary?: string | null;
  error?: string | null;
  tools?: string[];
  text_fragment?: string;
  [key: string]: unknown;
}

// ─── Constants ──────────────────────────────────────────────────────────

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const SUCCESS_RATE_MIN = 0.40;

// ─── Blocklists (canonical source — import from here, define nowhere else) ─

/**
 * ACEFORGE_TOOL_BLOCKLIST — AceForge's own tools + session management + system tools.
 * Used by: analyze.ts (groupPatterns), cross-session.ts, gap-detect.ts
 */
export const ACEFORGE_TOOL_BLOCKLIST = new Set([
  "forge", "forge_status", "forge_reflect", "forge_propose",
  "forge_approve_skill", "forge_reject_skill", "forge_quality",
  "forge_approve", "forge_reject", "forge_retire", "forge_reinstate",
  "forge_registry", "forge_rewards", "forge_gaps",
  "forge_retire_skill", "forge_tree", "forge_cross_session", "forge_compose",
  "forge_behavior_gaps", "forge_optimize",
  "forge_test", "forge_challenge", "forge_adversarial",
  "sessions_spawn", "sessions_list", "sessions_send", "sessions_history",
  "process", "message", "notify",
]);

/**
 * CAPTURE_BLOCKLIST — Subset of ACEFORGE_TOOL_BLOCKLIST for trace capture.
 * Does NOT include process/message/notify — those are user-facing system tools
 * that should be captured in traces but not analyzed for skill generation.
 * Used by: capture.ts
 */
export const CAPTURE_BLOCKLIST = new Set([
  "forge", "forge_status", "forge_reflect", "forge_propose",
  "forge_approve_skill", "forge_reject_skill", "forge_approve", "forge_reject",
  "forge_quality", "forge_registry", "forge_rewards", "forge_gaps",
  "forge_retire", "forge_retire_skill", "forge_reinstate",
  "forge_tree", "forge_cross_session", "forge_compose",
  "forge_behavior_gaps", "forge_optimize",
  "forge_test", "forge_challenge", "forge_adversarial",
  "sessions_spawn", "sessions_list", "sessions_send", "sessions_history",
]);

/**
 * NATIVE_TOOLS — Built-in OpenClaw tools that should never get skill proposals.
 * Sub-pattern clustering (exec-docker, read-code, etc.) handles these instead.
 * Used by: analyze.ts (native tool detection), index.ts (startup revalidation)
 */
export const NATIVE_TOOLS = new Set([
  "exec", "write", "edit", "delete", "move", "copy",
  "read", "pdf", "image", "browser", "web_fetch", "web_search",
  "session_send", "sessions_send", "broadcast",
  "message", "notify", "process", "exec-ssh",
  "memory_search", "memory_recall", "memory_store",
  "file_head", "file_write", "file_read",
  "apply_patch", "grep", "glob", "list_directory",
  "tavily_search", "tavily_extract",
  "gateway",
  ...ACEFORGE_TOOL_BLOCKLIST,
]);

/**
 * SELF_TOOLS — Native primitives + tool blocklist. Superset of ACEFORGE_TOOL_BLOCKLIST.
 * Used by: test suite (consistency verification)
 */
export const SELF_TOOLS = new Set([
  "exec", "write", "edit", "delete", "move", "copy",
  "read", "pdf", "image", "browser", "web_fetch", "web_search",
  "session_send", "sessions_send", "broadcast",
  "message", "notify", "process", "exec-ssh",
  "memory_search", "memory_recall", "memory_store",
  "file_head", "file_write", "file_read",
  ...ACEFORGE_TOOL_BLOCKLIST,
]);
