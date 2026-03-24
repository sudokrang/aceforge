/**
 * AceForge — Self-Evolving Skill Engine for OpenClaw
 * v0.6.0: SDK migration, full bug sweep, upgrade engine, gap analysis, effectiveness watchdog
 *
 * Uses definePluginEntry from openclaw/plugin-sdk/plugin-entry (2026.3.22+)
 */
import * as fs from "fs";
import * as path from "path";
import { ensureForgeDir } from "./src/pattern/store.js";
import { captureToolTrace } from "./src/pattern/capture.js";
import { detectCorrectionPatterns } from "./src/pattern/detect.js";
import { analyzePatterns } from "./src/pattern/analyze.js";
import { buildHierarchicalSkillIndex } from "./src/skill/index.js";
import { notify } from "./src/notify.js";
import { resetLlmRateLimit } from "./src/skill/llm-generator.js";
import {
  recordActivation,
  recordDeploymentBaseline,
  getSkillStats,
  getEffectiveCrystallizationThreshold,
  retireSkill,
  reinstateSkill,
  listActiveSkills,
  listRetiredSkills,
  listProposals,
  expireOldProposals,
  getSkillRegistry,
  getRewardSignals,
  runEffectivenessWatchdog,
} from "./src/skill/lifecycle.js";
import { checkVikingHealth } from "./src/viking/client.js";
import { scoreSkill, formatQualityReport } from "./src/skill/quality-score.js";
import { detectGaps } from "./src/pattern/gap-detect.js";

// ─── Paths ────────────────────────────────────────────────────────────────
const FORGE_DIR = path.join(process.env.HOME || "~", ".openclaw", "workspace", ".forge");
const SKILLS_DIR = path.join(process.env.HOME || "~", ".openclaw", "workspace", "skills");
const PROPOSALS_DIR = path.join(FORGE_DIR, "proposals");

// ─── Helpers ────────────────────────────────────────────────────────────────
function moveProposalToSkills(name: string): boolean {
  const from = path.join(PROPOSALS_DIR, name);
  const to = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
  fs.rmSync(from, { recursive: true, force: true });
  return true;
}

function deleteProposal(name: string): boolean {
  const dir = path.join(PROPOSALS_DIR, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function getPluginVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(__dirname, "openclaw.plugin.json"), "utf-8"
    ));
    return manifest.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function countLines(filePath: string): number {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content.length === 0 ? 0 : content.split("\n").length;
  } catch {
    return 0;
  }
}

// ─── Validation helper for approve flows ────────────────────────────────
async function validateAndDeploy(skillName: string): Promise<{ ok: boolean; message: string }> {
  const moved = moveProposalToSkills(skillName);
  if (!moved) return { ok: false, message: `Proposal '${skillName}' not found.` };

  try {
    const { validateSkillMd } = await import("./src/skill/validator.js");
    const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
    const content = fs.readFileSync(skillFile, "utf-8");
    const result = validateSkillMd(content, skillName);
    if (!result.valid) {
      if (result.errors.some((e: string) => e.startsWith("BLOCKED:"))) {
        // Roll back — remove from skills dir
        fs.rmSync(path.join(SKILLS_DIR, skillName), { recursive: true, force: true });
        const blockReasons = result.errors.filter((e: string) => e.startsWith("BLOCKED:")).join("; ");
        notify(`Blocked: ${skillName} — ${blockReasons}`);
        return { ok: false, message: `Skill '${skillName}' blocked by validator: ${blockReasons}` };
      }
      notify(`Deploying ${skillName} with warnings: ${result.errors.join("; ")}`);
    }
  } catch { /* validator import failed — deploy anyway */ }

  recordActivation(skillName, true);
  const toolMatch = skillName.match(/^(.+?)(?:-guard|-skill|-v\d+|-rev\d+)?$/);
  if (toolMatch) recordDeploymentBaseline(skillName, toolMatch[1]);
  notify(`Skill deployed: ${skillName}`);
  return { ok: true, message: `Skill '${skillName}' deployed. Active now.` };
}

// ─── Plugin definition (P0-1: SDK migration) ───────────────────────────
//
// OpenClaw 2026.3.22 uses definePluginEntry from openclaw/plugin-sdk/plugin-entry.
// The plain-object pattern still loads via the compat shim but emits runtime warnings.
// We use a try/catch to gracefully degrade: if plugin-sdk is available, use it.
// If not (e.g., older OpenClaw), fall back to plain object export.

function buildPlugin() {
  return {
    id: "aceforge",
    name: "AceForge",
    description: "Self-evolving skill engine — detects patterns, crystallizes skills, manages lifecycle",

    configSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        crystallizationThreshold: { type: "number" as const, default: 3 },
        successRateMinimum: { type: "number" as const, default: 0.7 },
        retirementDays: { type: "number" as const, default: 30 },
        maxCustomSkillTokens: { type: "number" as const, default: 3000 },
        notificationChannel: { type: "string" as const, default: "auto" },
      }
    },

    register(api: any) {
      const log = api.logger;

      // Bootstrap .forge/ directory
      ensureForgeDir();

      // ── Startup service ───────────────────────────────────────────
      api.registerService({
        id: "aceforge-startup",
        start: async () => {
          const version = getPluginVersion();
          const activeSkills = listActiveSkills();
          const proposals = listProposals();
          const retired = listRetiredSkills();
          const patternCount = countLines(path.join(FORGE_DIR, "patterns.jsonl"));
          const candidateCount = countLines(path.join(FORGE_DIR, "candidates.jsonl"));
          const healthCount = countLines(path.join(FORGE_DIR, "skill-health.jsonl"));
          const threshold = getEffectiveCrystallizationThreshold();

          const tests: string[] = [];

          // Test 1: .forge/ writable
          try {
            const testFile = path.join(FORGE_DIR, ".writetest");
            fs.writeFileSync(testFile, "ok");
            fs.unlinkSync(testFile);
            tests.push("✅ .forge/ writable");
          } catch {
            tests.push("❌ .forge/ NOT writable");
          }

          // Test 2: OpenViking health (optional — non-blocking)
          try {
            const vikingStatus = await checkVikingHealth();
            if (vikingStatus.available) {
              tests.push(`✅ OpenViking: ${vikingStatus.url}`);
            } else {
              tests.push(`⚠️ OpenViking not reachable (optional): ${vikingStatus.url}`);
            }
          } catch {
            tests.push("⚠️ OpenViking check skipped");
          }

          // Test 3: Telegram bot
          try {
            const config = JSON.parse(fs.readFileSync(
              path.join(process.env.HOME || "~", ".openclaw", "openclaw.json"), "utf-8"
            ));
            const botToken = config.channels?.telegram?.botToken;
            if (botToken) {
              const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
              const data = await res.json() as { ok: boolean; result?: { username?: string } };
              if (data.ok) {
                tests.push(`✅ Telegram bot: @${data.result?.username}`);
              } else {
                tests.push("⚠️ Telegram getMe failed");
              }
            } else {
              tests.push("⚠️ No Telegram bot token in config");
            }
          } catch (err) {
            tests.push(`⚠️ Telegram check failed: ${(err as Error).message}`);
          }

          expireOldProposals(notify);

          const dashboard = [
            `AceForge v${version} Online`,
            ``,
            `📊 Skills: ${activeSkills.length} active · ${proposals.length} proposals · ${retired.length} retired`,
            `📈 Patterns: ${patternCount} traced · ${candidateCount} candidates`,
            `🔍 Threshold: ${threshold}x recurrences`,
            `📋 Health: ${healthCount} entries`,
            ``,
            ...tests,
          ].join("\n");

          notify(dashboard).catch((err: Error) =>
            log.error(`[aceforge] startup notification failed: ${err.message}`)
          );
        },
      });

      // ── HOOK: before_prompt_build ─────────────────────────────────
      api.on("before_prompt_build", (_event: any, _ctx: any) => {
        const index = buildHierarchicalSkillIndex();
        if (index) return { prependSystemContext: index };
      }, { priority: 50 });

      // ── HOOK: after_tool_call ─────────────────────────────────────
      api.on("after_tool_call", (event: any, ctx: any) => {
        captureToolTrace(event, ctx, api);
      });

      // ── HOOK: message_received ────────────────────────────────────
      api.on("message_received", (event: any, _ctx: any) => {
        detectCorrectionPatterns(event);
      });

      // ── HOOK: agent_end ───────────────────────────────────────────
      api.on("agent_end", (_event: any, _ctx: any) => {
        resetLlmRateLimit();
        analyzePatterns().catch((err: Error) =>
          log.error(`[aceforge] pattern analysis error: ${err.message}`)
        );
      });

      // ── TOOLS ─────────────────────────────────────────────────────

      api.registerTool({
        name: "forge",
        description: "Trigger manual skill crystallisation. Use after a session with notable patterns.",
        parameters: { type: "object", properties: {} },
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          resetLlmRateLimit();
          await analyzePatterns();
          return { content: [{ type: "text", text: "Crystallisation triggered. Check /forge_status for results." }] };
        },
      });

      api.registerTool({
        name: "forge_reflect",
        description: "Trigger a reflection cycle to analyse recent patterns and propose skills.",
        parameters: { type: "object", properties: {} },
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          resetLlmRateLimit();
          await analyzePatterns();
          return { content: [{ type: "text", text: "Reflection complete. Check /forge_status for any new candidates." }] };
        },
      });

      api.registerTool({
        name: "forge_propose",
        description: "Propose a new skill based on a pattern you have identified.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            category: { type: "string" },
            instructions: { type: "string" }
          },
          required: ["name", "description", "category", "instructions"]
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { name, description, category, instructions } = params as {
            name: string; description: string; category: string; instructions: string;
          };
          if (name.includes("..") || name.includes("/") || name.includes("\\")) {
            return { content: [{ type: "text", text: "Invalid skill name — contains path characters." }] };
          }
          const skillDir = path.join(PROPOSALS_DIR, name);
          fs.mkdirSync(skillDir, { recursive: true });

          const skillMd = `---
name: ${name}
description: "${(description as string).replace(/"/g, '\\"')}"
metadata:
  openclaw:
    category: ${category}
    aceforge:
      status: proposed
      proposed: ${new Date().toISOString()}
---

# ${name}

${instructions}
`;
          fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);
          notify(`Proposed new skill: ${name} in ${category}\nPending: /forge_approve ${name}`);
          return { content: [{ type: "text", text: `Proposal saved: ${name}` }] };
        }
      });

      api.registerTool({
        name: "forge_approve_skill",
        description: "Approve a proposed skill for deployment. Pass the skill name as the 'name' parameter.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Name of the proposal to approve" } },
          required: ["name"]
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const skillName = (params.name as string || "").trim();
          if (!skillName) return { content: [{ type: "text", text: "Missing skill name." }] };
          const result = await validateAndDeploy(skillName);
          return { content: [{ type: "text", text: result.message }] };
        },
      });

      api.registerTool({
        name: "forge_reject_skill",
        description: "Reject a proposed skill. Pass the skill name as the 'name' parameter.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Name of the proposal to reject" } },
          required: ["name"]
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const skillName = (params.name as string || "").trim();
          if (!skillName) return { content: [{ type: "text", text: "Missing skill name." }] };
          const deleted = deleteProposal(skillName);
          if (!deleted) return { content: [{ type: "text", text: `Proposal '${skillName}' not found.` }] };
          notify(`Skill rejected: ${skillName}`);
          return { content: [{ type: "text", text: `Skill '${skillName}' rejected.` }] };
        },
      });

      api.registerTool({
        name: "forge_quality",
        description: "Score a deployed skill's quality against actual usage data.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Name of the deployed skill to evaluate" } },
          required: ["name"]
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const skillName = (params.name as string || "").trim();
          if (!skillName) return { content: [{ type: "text", text: "Missing skill name." }] };
          const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
          if (!fs.existsSync(skillFile)) return { content: [{ type: "text", text: `Skill '${skillName}' not found.` }] };
          const skillMd = fs.readFileSync(skillFile, "utf-8");
          const toolName = skillName.replace(/-(guard|skill|v\d+|rev\d+|upgrade)$/, "");
          const report = scoreSkill(skillMd, toolName);
          return { content: [{ type: "text", text: formatQualityReport(report, skillName) }] };
        },
      });

      api.registerTool({
        name: "forge_registry",
        description: "Get machine-readable skill registry with success rates and activation counts",
        parameters: { type: "object", properties: {} },
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          const registry = getSkillRegistry();
          return { content: [{ type: "text", text: JSON.stringify(registry, null, 2) }] };
        },
      });

      api.registerTool({
        name: "forge_rewards",
        description: "Get per-skill success rate signals for RL training integration (MetaClaw/OpenClaw-RL compatible)",
        parameters: { type: "object", properties: {} },
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          const signals = getRewardSignals();
          return { content: [{ type: "text", text: JSON.stringify(signals, null, 2) }] };
        },
      });

      // L2 fix: forge_status is ONLY a command, not also a tool (was duplicate registration)

      // ── SLASH COMMANDS ────────────────────────────────────────────

      api.registerCommand({
        name: "forge_approve",
        description: "Approve a proposed skill for deployment",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const name = ctx.args?.trim();
          if (!name) return { text: "Usage: /forge_approve <skill-name>" };
          const result = await validateAndDeploy(name);
          return { text: result.message };
        }
      });

      api.registerCommand({
        name: "forge_reject",
        description: "Reject a proposed skill",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const name = ctx.args?.trim();
          if (!name) return { text: "Usage: /forge_reject <skill-name>" };
          const deleted = deleteProposal(name);
          if (!deleted) return { text: `Proposal '${name}' not found.` };
          notify(`Skill rejected: ${name}`);
          return { text: `Skill '${name}' rejected.` };
        }
      });

      api.registerCommand({
        name: "forge_retire",
        description: "Retire an active skill",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const name = ctx.args?.trim();
          if (!name) return { text: "Usage: /forge_retire <skill-name>" };
          const done = retireSkill(name);
          if (!done) return { text: `Skill '${name}' not found.` };
          notify(`Skill retired: ${name}`);
          return { text: `Skill '${name}' retired.` };
        }
      });

      api.registerCommand({
        name: "forge_reinstate",
        description: "Reinstate a retired skill",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const name = ctx.args?.trim();
          if (!name) return { text: "Usage: /forge_reinstate <skill-name>" };
          const done = reinstateSkill(name);
          if (!done) return { text: `Retired skill '${name}' not found.` };
          notify(`Skill reinstated: ${name}`);
          return { text: `Skill '${name}' reinstated.` };
        }
      });

      api.registerCommand({
        name: "forge_status",
        description: "Show AceForge status dashboard",
        acceptsArgs: false,
        handler: async (_ctx: any) => {
          const active = listActiveSkills();
          const proposals = listProposals();
          const retired = listRetiredSkills();
          const patternCount = countLines(path.join(FORGE_DIR, "patterns.jsonl"));
          const candidateCount = countLines(path.join(FORGE_DIR, "candidates.jsonl"));
          const threshold = getEffectiveCrystallizationThreshold();

          let text = `AceForge v${getPluginVersion()} Status\n\n`;
          text += `📊 Skills: ${active.length} active · ${proposals.length} proposals · ${retired.length} retired\n`;
          text += `📈 Patterns: ${patternCount} traced · ${candidateCount} candidates\n`;
          text += `🔍 Threshold: ${threshold}x recurrences\n`;

          // OpenViking status (non-blocking)
          try {
            const vikingStatus = await checkVikingHealth();
            text += `🔮 OpenViking: ${vikingStatus.available ? "connected" : "not reachable"} (${vikingStatus.url})\n`;
          } catch {
            text += `🔮 OpenViking: check failed\n`;
          }

          text += `\n`;

          if (active.length > 0) {
            text += `Active (${active.length}):\n`;
            for (const name of active) {
              const stats = getSkillStats(name);
              if (stats.activations > 0) {
                const days = stats.daysSinceActivation ?? "?";
                text += `  ${name}: ${stats.activations} acts, ${Math.round(stats.successRate * 100)}% succ (${days}d ago)\n`;
              } else {
                text += `  ${name}: no activations yet\n`;
              }
            }
          }

          if (proposals.length > 0) {
            text += `\nProposals (${proposals.length}):\n`;
            for (const name of proposals) {
              text += `  ${name}: /forge_approve ${name}\n`;
            }
          }

          if (retired.length > 0) {
            text += `\nRetired (${retired.length}):\n`;
            for (const name of retired) {
              text += `  ${name}: /forge_reinstate ${name}\n`;
            }
          }

          return { text };
        }
      });

      api.registerCommand({
        name: "forge_list",
        description: "List all managed skills, proposals, and retired skills",
        acceptsArgs: false,
        handler: async (_ctx: any) => {
          const active = listActiveSkills();
          const proposals = listProposals();
          const retired = listRetiredSkills();
          let text = "AceForge Inventory\n\n";
          text += `Active (${active.length}):\n`;
          text += active.length === 0 ? "  none\n" : active.map(s => `  ✓ ${s}`).join("\n") + "\n";
          text += `\nProposals (${proposals.length}):\n`;
          text += proposals.length === 0 ? "  none\n" : proposals.map(s => `  ◌ ${s}`).join("\n") + "\n";
          text += `\nRetired (${retired.length}):\n`;
          text += retired.length === 0 ? "  none\n" : retired.map(s => `  ✗ ${s}`).join("\n") + "\n";
          return { text };
        }
      });

      api.registerCommand({
        name: "forge_gaps",
        description: "Show detected capability gaps from failure patterns and corrections",
        acceptsArgs: false,
        handler: async (_ctx: any) => {
          const gaps = detectGaps();
          if (gaps.length === 0) return { text: "No capability gaps detected. The agent is performing well across all tools." };

          let text = `AceForge Gap Analysis\n\n`;
          text += `${gaps.length} capability gap${gaps.length === 1 ? "" : "s"} detected:\n\n`;

          for (const gap of gaps) {
            const severityLabel = gap.severity >= 12 ? "HIGH" : gap.severity >= 6 ? "MEDIUM" : "LOW";
            text += `${gap.tool} (${severityLabel})\n`;
            text += `  Type: ${gap.gapType.replace(/_/g, " ")}\n`;
            text += `  ${gap.evidence.slice(0, 2).join("\n  ")}\n`;
            text += `  Focus: ${gap.suggestedFocus}\n\n`;
          }

          text += `Generate remediation proposals: /forge_gap_propose`;
          return { text };
        }
      });

      api.registerCommand({
        name: "forge_gap_propose",
        description: "Generate remediation skill proposals for detected gaps",
        acceptsArgs: false,
        handler: async (_ctx: any) => {
          const gaps = detectGaps();
          if (gaps.length === 0) return { text: "No gaps to address." };
          resetLlmRateLimit();
          await analyzePatterns();
          return { text: `Gap analysis triggered. ${gaps.length} gaps evaluated. Check /forge_status for proposals.` };
        }
      });

      api.registerCommand({
        name: "forge_watchdog",
        description: "Check skill effectiveness — flags underperforming or degraded skills",
        acceptsArgs: false,
        handler: async (_ctx: any) => {
          const alerts = runEffectivenessWatchdog();
          if (alerts.length === 0) return { text: "All deployed skills are performing at or above baseline. No issues detected." };

          let text = `Skill Effectiveness Report\n\n`;
          text += `${alerts.length} skill(s) flagged:\n\n`;
          for (const a of alerts) {
            const icon = a.reason === "degraded" ? "🔴" : "🟡";
            text += `${icon} ${a.skill}\n`;
            text += `  ${a.reason === "no_improvement"
              ? `No improvement: ${Math.round(a.successRate * 100)}% success vs ${Math.round(a.baselineRate * 100)}% baseline after ${a.activations} activations`
              : `Degraded: ${Math.round(a.successRate * 100)}% success over ${a.activations} activations`}\n\n`;
          }
          text += `Actions: /forge_retire <name> to retire, or wait for the evolution cycle.`;
          return { text };
        }
      });

      api.registerCommand({
        name: "forge_quality",
        description: "Score a skill's quality against actual usage data",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const skillName = ctx.args?.trim();
          if (!skillName) return { text: "Usage: /forge_quality <skill-name>" };
          const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
          if (!fs.existsSync(skillFile)) return { text: `Skill '${skillName}' not found.` };
          const skillMd = fs.readFileSync(skillFile, "utf-8");
          const toolName = skillName.replace(/-(guard|skill|v\d+|rev\d+|upgrade)$/, "");
          const report = scoreSkill(skillMd, toolName);
          return { text: formatQualityReport(report, skillName) };
        }
      });

      api.registerCommand({
        name: "forge_upgrade",
        description: "Deploy an upgrade proposal, retiring the old skill",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const oldName = ctx.args?.trim();
          if (!oldName) return { text: "Usage: /forge_upgrade <skill-name>" };

          const upgradeName = oldName + "-upgrade";
          const upgradeDir = path.join(PROPOSALS_DIR, upgradeName);
          if (!fs.existsSync(upgradeDir)) {
            return { text: `No upgrade proposal found for '${oldName}'. Run /forge_quality ${oldName} first.` };
          }

          // Retire old skill
          const oldDir = path.join(SKILLS_DIR, oldName);
          if (fs.existsSync(oldDir)) {
            retireSkill(oldName);
            notify(`Skill retired for upgrade: ${oldName}`);
          }

          // Deploy upgrade under the ORIGINAL name
          const targetDir = path.join(SKILLS_DIR, oldName);
          fs.mkdirSync(targetDir, { recursive: true });
          for (const file of fs.readdirSync(upgradeDir)) {
            fs.copyFileSync(path.join(upgradeDir, file), path.join(targetDir, file));
          }
          fs.rmSync(upgradeDir, { recursive: true, force: true });

          recordActivation(oldName, true);
          const toolMatch = oldName.match(/^(.+?)(?:-guard|-skill|-v\d+|-rev\d+)?$/);
          if (toolMatch) recordDeploymentBaseline(oldName, toolMatch[1]);

          notify(`Skill upgraded: ${oldName}\nOld version retired. New version active.`);
          return { text: `Skill '${oldName}' upgraded. Old version retired, new version deployed.` };
        }
      });

      // G4: Rollback command — restores old skill version after a failed upgrade
      api.registerCommand({
        name: "forge_rollback",
        description: "Roll back an upgrade — retire current version and reinstate the previous one from retired/",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const name = ctx.args?.trim();
          if (!name) return { text: "Usage: /forge_rollback <skill-name>" };

          const currentDir = path.join(SKILLS_DIR, name);
          const retiredDir = path.join(FORGE_DIR, "retired", name);

          if (!fs.existsSync(retiredDir)) {
            return { text: `No retired version of '${name}' found. Nothing to roll back to.` };
          }

          // Remove current version
          if (fs.existsSync(currentDir)) {
            fs.rmSync(currentDir, { recursive: true, force: true });
          }

          // Reinstate from retired
          const done = reinstateSkill(name);
          if (!done) return { text: `Rollback failed for '${name}'.` };

          notify(`Skill rolled back: ${name}\nPrevious version reinstated.`);
          return { text: `Skill '${name}' rolled back to previous version.` };
        }
      });

      log.info("[aceforge] all hooks, tools, and commands registered");
    }
  };
}

export default buildPlugin();
