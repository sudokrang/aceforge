/**
 * Skill generator — turns a crystallization candidate into a SKILL.md
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";

const FORGE_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  ".forge"
);

function inferCategory(toolName: string): string {
  const tool = toolName.toLowerCase();
  const ops = ["exec", "exec-ssh", "scp", "rsync"];
  const mon = ["web-fetch", "web_search", "browser", "browser-screenshot", "web_fetch", "web-search"];
  const ana = ["read", "pdf", "image", "image-analyze", "memory_search", "memory_recall", "memory_store"];
  const dev = ["write", "edit", "delete", "move", "copy"];
  const com = ["message", "session_send", "broadcast"];
  if (ops.includes(tool)) return "operations";
  if (mon.includes(tool)) return "monitoring";
  if (ana.includes(tool)) return "analysis";
  if (dev.includes(tool)) return "development";
  if (com.includes(tool)) return "communication";
  return "general";
}

export interface Candidate {
  tool: string;
  args_summary_prefix: string;
  occurrences: number;
  success_rate: number;
  distinct_sessions: number;
  first_seen: string;
  last_seen: string;
}

export function generateSkillFromCandidate(candidate: Candidate): { skillName: string; skillMd: string } {
  const sanitized = candidate.tool.replace(/[^a-z0-9-_]/gi, "_").toLowerCase();
  const skillName = `auto-${sanitized}`;

  const description =
    `Auto-crystallized skill triggered by ${candidate.occurrences}x ` +
    `${candidate.tool} calls (${Math.round(candidate.success_rate * 100)}% success ` +
    `across ${candidate.distinct_sessions} sessions). ` +
    `Pattern: "${candidate.args_summary_prefix}..."`;

  const instructions =
    `## When to Use\n\n` +
    `Use this skill when you need to run: ${candidate.tool}\n\n` +
    `## Detected Pattern\n\n` +
    `Arguments matching: ${candidate.args_summary_prefix}...\n\n` +
    `## Instructions\n\n` +
    `1. Execute the \`${candidate.tool}\` tool with arguments matching the pattern above\n` +
    `2. Expected success rate: ${Math.round(candidate.success_rate * 100)}%\n` +
    `3. First observed: ${candidate.first_seen}\n\n` +
    `## Anti-Patterns\n\n` +
    `- Do NOT use if arguments don't match the detected pattern\n` +
    `- Do NOT use if context has changed significantly\n` +
    `- Do NOT use if error rate is elevated since ${candidate.first_seen}`;

  const skillMd = [
    "---",
    `name: ${skillName}`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    "metadata:",
    "  openclaw:",
    `    category: ${inferCategory(candidate.tool)}`,
    "    aceforge:",
    `      status: proposed`,
    `      proposed: ${new Date().toISOString()}`,
    `      auto_generated: true`,
    `      candidate_occurrences: ${candidate.occurrences}`,
    `      candidate_success_rate: ${candidate.success_rate}`,
    `      first_seen: ${candidate.first_seen}`,
    "---",
    "",
    `# ${skillName}`,
    "",
    instructions,
  ].join("\n");

  return { skillName, skillMd };
}

export function writeProposal(skillName: string, skillMd: string): string {
  const proposalDir = path.join(FORGE_DIR, "proposals", skillName);

  // Dry-run mode: log what would be proposed without writing to disk
  if (process.env.ACEFORGE_DRY_RUN === "true" || process.env.ACEFORGE_DRY_RUN === "1") {
    const descMatch = skillMd.match(/^description:\s*["']?(.+?)["']?$/m);
    const summary = descMatch ? descMatch[1].slice(0, 120) : "No description";
    console.log(`[aceforge/dry-run] Would propose: ${skillName} — ${summary}`);
    return proposalDir;
  }

  fsSync.mkdirSync(proposalDir, { recursive: true });

  // Guarantee aceforge metadata exists on every proposal (LLM output may omit it)
  let finalMd = skillMd;
  if (!finalMd.includes("aceforge:")) {
    const aceforgeBlock = [
      "    aceforge:",
      "      status: proposed",
      `      proposed: ${new Date().toISOString()}`,
      "      auto_generated: true",
    ].join("\n");
    // Insert after openclaw: block
    if (finalMd.includes("openclaw:")) {
      const categoryMatch = finalMd.match(/^(\s*category:\s*.+)$/m);
      if (categoryMatch) {
        finalMd = finalMd.replace(categoryMatch[0], categoryMatch[0] + "\n" + aceforgeBlock);
      }
    }
  } else if (!finalMd.includes("status: proposed") && !finalMd.includes("status: deployed")) {
    // Has aceforge block but missing status
    finalMd = finalMd.replace(/aceforge:/, "aceforge:\n      status: proposed");
  }

  fsSync.writeFileSync(path.join(proposalDir, "SKILL.md"), finalMd, "utf-8");
  return proposalDir;
}
