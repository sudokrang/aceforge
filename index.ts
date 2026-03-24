/**
 * AceForge — Self-Evolving Skill Engine for OpenClaw
 * v0.7.5: Proposal pipeline quality gates — F1-F5 — replaced 20 commands with subcommand dispatch — C1/H1/H2/H3/H4/H5/M7 applied
 *
 * Phase 1: Core engine (v0.1–v0.6.1) — pattern detection, skill crystallization, lifecycle
 * Phase 2: Proactive intelligence — capability tree, cross-session propagation, composition,
 *          proactive gap detection, description optimization, autonomous adjustment
 * Phase 3: Self-validation — health testing, grounded challenges, adversarial robustness
 */
import * as fs from "fs";
import * as os from "os";
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
  revalidateProposals,
} from "./src/skill/lifecycle.js";
import { checkVikingHealth } from "./src/viking/client.js";
import { scoreSkill, formatQualityReport } from "./src/skill/quality-score.js";
import { detectGaps } from "./src/pattern/gap-detect.js";

// ─── Phase 2 imports ────────────────────────────────────────────────────
import { buildCapabilityTree, formatCapabilityTree, getPriorityDomains } from "./src/intelligence/capability-tree.js";
import { mergePatterns, formatCrossSessionReport, getCrossSessionCandidates } from "./src/intelligence/cross-session.js";
import { detectCoActivations, formatCompositionReport, getCompositionCandidates } from "./src/intelligence/composition.js";
import { summarizeBehaviorGaps, formatBehaviorGapReport, updateTreeWithBehaviorGaps } from "./src/intelligence/proactive-gaps.js";
import { detectDescriptionMismatches, formatOptimizationReport } from "./src/intelligence/description-optimizer.js";
import { handleCorrectionForSkill } from "./src/intelligence/auto-adjust.js";

// ─── Phase 3 imports ────────────────────────────────────────────────────
import { runAllHealthTests, formatHealthTestReport } from "./src/validation/health-test.js";
import { generateChallenges, formatChallengeReport } from "./src/validation/grounded-challenges.js";
import { runAdversarialTests, formatAdversarialReport } from "./src/validation/adversarial.js";

// ─── Paths ────────────────────────────────────────────────────────────────
const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
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

  // Rebuild capability tree after deployment
  try { buildCapabilityTree(); } catch { /* non-critical */ }

  notify(`Skill deployed: ${skillName}`);
  return { ok: true, message: `Skill '${skillName}' deployed. Active now.` };
}

// ─── Plugin definition ──────────────────────────────────────────────────

function buildPlugin() {
  return {
    id: "aceforge",
    name: "AceForge",
    description: "Self-evolving skill engine — detects patterns, crystallizes skills, manages lifecycle",

    // H5 fix: removed maxCustomSkillTokens (dead — nothing reads it).
    // Canonical schema lives in openclaw.plugin.json; this is for compat shim only.
    configSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        crystallizationThreshold: { type: "number" as const, default: 3 },
        successRateMinimum: { type: "number" as const, default: 0.7 },
        retirementDays: { type: "number" as const, default: 30 },
        notificationChannel: { type: "string" as const, default: "auto" },
      }
    },

    register(api: any) {
      const log = api.logger;

      // Bootstrap .forge/ directory
      ensureForgeDir();

      // ══════════════════════════════════════════════════════════════
      // STARTUP SERVICE
      // ══════════════════════════════════════════════════════════════

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
            tests.push(vikingStatus.available
              ? `✅ OpenViking: ${vikingStatus.url}`
              : `⚠️ OpenViking not reachable (optional): ${vikingStatus.url}`
            );
          } catch {
            tests.push("⚠️ OpenViking check skipped");
          }

          // Test 3: Telegram bot
          try {
            const config = JSON.parse(fs.readFileSync(
              path.join(HOME, ".openclaw", "openclaw.json"), "utf-8"
            ));
            const botToken = config.channels?.telegram?.botToken;
            if (botToken) {
              const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
              const data = await res.json() as { ok: boolean; result?: { username?: string } };
              tests.push(data.ok ? `✅ Telegram bot: @${data.result?.username}` : "⚠️ Telegram getMe failed");
            } else {
              tests.push("⚠️ No Telegram bot token in config");
            }
          } catch (err) {
            tests.push(`⚠️ Telegram check failed: ${(err as Error).message}`);
          }

          // Test 4: Adversarial robustness (Phase 3C)
          try {
            const advReport = runAdversarialTests();
            tests.push(advReport.missed === 0
              ? `✅ Adversarial: ${advReport.caught}/${advReport.totalMutations} mutations caught`
              : `⚠️ Adversarial: ${advReport.missed} mutations MISSED (${advReport.caught}/${advReport.totalMutations} caught)`
            );
          } catch {
            tests.push("⚠️ Adversarial test skipped");
          }

          expireOldProposals(notify);

          // F3 fix: revalidate proposals against current native tool list
          const STARTUP_NATIVE_TOOLS = new Set([
            "exec", "write", "edit", "delete", "move", "copy",
            "read", "pdf", "image", "browser", "web_fetch", "web_search",
            "session_send", "sessions_send", "broadcast",
            "message", "notify", "process", "exec-ssh",
            "memory_search", "memory_recall", "memory_store",
            "file_head", "file_write", "file_read",
            "apply_patch", "grep", "glob", "list_directory",
            "tavily_search", "tavily_extract",
          ]);
          try {
            const removed = revalidateProposals(STARTUP_NATIVE_TOOLS, notify);
            if (removed.length > 0) {
              tests.push(`🧹 Revalidation: removed ${removed.length} stale proposal(s): ${removed.join(", ")}`);
            }
          } catch { /* non-critical */ }

          // Phase 2: Build capability tree on startup
          try { buildCapabilityTree(); } catch { /* non-critical */ }
          // Phase 2: Merge cross-session patterns on startup
          try { mergePatterns(); } catch { /* non-critical */ }

          const priorityDomains = getPriorityDomains(0.4);
          const priorityLine = priorityDomains.length > 0
            ? `🎯 Priority gaps: ${priorityDomains.map(d => `${d.domain} (${Math.round(d.gapScore * 100)}%)`).join(", ")}`
            : "";

          const dashboard = [
            `AceForge v${version} Online`,
            ``,
            `📊 Skills: ${activeSkills.length} active · ${proposals.length} proposals · ${retired.length} retired`,
            `📈 Patterns: ${patternCount} traced · ${candidateCount} candidates`,
            `🔍 Threshold: ${threshold}x recurrences`,
            `📋 Health: ${healthCount} entries`,
            priorityLine,
            ``,
            ...tests,
          ].filter(Boolean).join("\n");

          notify(dashboard).catch((err: Error) =>
            log.error(`[aceforge] startup notification failed: ${err.message}`)
          );
        },
      });

      // ══════════════════════════════════════════════════════════════
      // HOOKS (infrastructure-enforced)
      // ══════════════════════════════════════════════════════════════

      // Inject hierarchical skill index before each prompt
      api.on("before_prompt_build", (_event: any, _ctx: any) => {
        const index = buildHierarchicalSkillIndex();
        if (index) return { prependSystemContext: index };
      }, { priority: 50 });

      // Capture tool traces after each tool call
      api.on("after_tool_call", (event: any, ctx: any) => {
        captureToolTrace(event, ctx, api);
      });

      // Detect correction patterns in incoming messages
      api.on("message_received", (event: any, _ctx: any) => {
        detectCorrectionPatterns(event);
      });

      // After full agent turn: analyze patterns + Phase 2/3 intelligence
      api.on("agent_end", (_event: any, _ctx: any) => {
        resetLlmRateLimit();

        // Phase 1: Core pattern analysis (async — non-blocking)
        analyzePatterns().catch((err: Error) =>
          log.error(`[aceforge] pattern analysis error: ${err.message}`)
        );

        // M7 fix: Phase 2 intelligence runs non-blocking via setImmediate
        setImmediate(() => {
          // Phase 2B: Cross-session merge
          try { mergePatterns(); } catch (err) {
            log.error(`[aceforge] cross-session merge error: ${(err as Error).message}`);
          }

          // Phase 2A: Capability tree rebuild
          try { buildCapabilityTree(); } catch (err) {
            log.error(`[aceforge] capability tree error: ${(err as Error).message}`);
          }

          // Phase 2D: Proactive behavior gap detection
          try {
            const behaviorGaps = summarizeBehaviorGaps();
            if (behaviorGaps.length > 0) {
              const criticalGaps = behaviorGaps.filter(g => g.count >= 5);
              if (criticalGaps.length > 0) {
                notify(
                  `Proactive Gap Alert\n` +
                  `${criticalGaps.length} critical behavior gap(s):\n` +
                  criticalGaps.map(g => `${g.domain}: ${g.gapType} (${g.count}x)`).join("\n")
                ).catch(() => {});
              }
            }
            updateTreeWithBehaviorGaps();
          } catch (err) {
            log.error(`[aceforge] behavior gap detection error: ${(err as Error).message}`);
          }

          // H1 fix: Phase 2F — Route recent corrections to auto-adjust
          try {
            const pFile = path.join(FORGE_DIR, "patterns.jsonl");
            if (fs.existsSync(pFile)) {
              const content = fs.readFileSync(pFile, "utf-8");
              if (content.trim()) {
                const fiveMinAgo = Date.now() - 5 * 60 * 1000;
                const lines = content.trim().split("\n").filter(l => l.trim());
                const recentCorrections: Array<{ text: string; session: string | null }> = [];
                const recentToolCalls: Array<{ tool: string; ts: number; args: string | null; session: string | null }> = [];

                // Only scan last 100 entries for performance
                for (const line of lines.slice(-100)) {
                  try {
                    const entry = JSON.parse(line);
                    const entryTime = new Date(entry.ts).getTime();
                    if (entryTime < fiveMinAgo) continue;

                    if (entry.type === "correction" && entry.text_fragment) {
                      recentCorrections.push({
                        text: entry.text_fragment || "",
                        session: entry.session || null,
                      });
                    } else if (entry.tool && entry.type !== "chain" && entry.type !== "correction") {
                      recentToolCalls.push({
                        tool: entry.tool,
                        ts: entryTime,
                        args: entry.args_summary || null,
                        session: entry.session || null,
                      });
                    }
                  } catch { /* skip malformed */ }
                }

                // For each recent correction, find nearest preceding tool call and route to auto-adjust
                for (const corr of recentCorrections) {
                  const nearestTool = recentToolCalls
                    .filter(t => !corr.session || t.session === corr.session)
                    .sort((a, b) => b.ts - a.ts)[0];

                  if (nearestTool) {
                    handleCorrectionForSkill(
                      nearestTool.tool,
                      corr.text.slice(0, 200),
                      nearestTool.args,
                      corr.session
                    );
                  }
                }
              }
            }
          } catch (err) {
            log.error(`[aceforge] auto-adjust routing error: ${(err as Error).message}`);
          }
        }); // end setImmediate
      });

      // ══════════════════════════════════════════════════════════════
      // TOOLS (agent-callable)
      // ══════════════════════════════════════════════════════════════

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
          const skillMd = `---\nname: ${name}\ndescription: "${(description as string).replace(/"/g, '\\"')}"\nmetadata:\n  openclaw:\n    category: ${category}\n    aceforge:\n      status: proposed\n      proposed: ${new Date().toISOString()}\n---\n\n# ${name}\n\n${instructions}\n`;
          fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);
          notify(`Proposed new skill: ${name} in ${category}\nPending: /forge_approve ${name}`);
          return { content: [{ type: "text", text: `Proposal saved: ${name}` }] };
        }
      });

      api.registerTool({
        name: "forge_approve_skill",
        description: "Approve a proposed skill for deployment.",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const skillName = (params.name as string || "").trim();
          if (!skillName) return { content: [{ type: "text", text: "Missing skill name." }] };
          const result = await validateAndDeploy(skillName);
          return { content: [{ type: "text", text: result.message }] };
        },
      });

      api.registerTool({
        name: "forge_reject_skill",
        description: "Reject a proposed skill.",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
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
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
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
        async execute() { return { content: [{ type: "text", text: JSON.stringify(getSkillRegistry(), null, 2) }] }; },
      });

      api.registerTool({
        name: "forge_rewards",
        description: "Get per-skill success rate signals for RL training integration",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: JSON.stringify(getRewardSignals(), null, 2) }] }; },
      });

      // Phase 2: Capability tree as machine-readable tool
      api.registerTool({
        name: "forge_tree",
        description: "Get the capability tree with gap scores per domain. Use for understanding where the agent needs new skills.",
        parameters: { type: "object", properties: {} },
        async execute() {
          const tree = buildCapabilityTree();
          return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
        },
      });

      // H4 fix: forge_gaps tool returns same unified output as the command
      api.registerTool({
        name: "forge_gaps",
        description: "Detect all capability gaps: tool failures, behavior patterns (fallback/deferral/uncertainty), and cross-session candidates.",
        parameters: { type: "object", properties: {} },
        async execute() {
          const text = buildUnifiedGapReport();
          return { content: [{ type: "text", text }] };
        },
      });

      // ══════════════════════════════════════════════════════════════
      // SLASH COMMAND — single /forge router (v0.7.3)
      // ══════════════════════════════════════════════════════════════

      api.registerCommand({
        name: "forge",
        description: "AceForge skill engine — run /forge for dashboard, /forge help for all subcommands",
        acceptsArgs: true,
        handler: async (ctx: any) => {
          const raw = (ctx.args || "").trim();
          const spaceIdx = raw.indexOf(" ");
          const sub = spaceIdx === -1 ? raw.toLowerCase() : raw.slice(0, spaceIdx).toLowerCase();
          const subArgs = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();

          switch (sub) {
            // ── No subcommand: dashboard ──
            case "":
            case "status": {
              const active = listActiveSkills();
              const proposals = listProposals();
              const retired = listRetiredSkills();
              const patternCount = countLines(path.join(FORGE_DIR, "patterns.jsonl"));
              const candidateCount = countLines(path.join(FORGE_DIR, "candidates.jsonl"));
              const threshold = getEffectiveCrystallizationThreshold();

              let text = `AceForge v${getPluginVersion()} Dashboard\n\n`;
              text += `📊 Skills: ${active.length} active · ${proposals.length} proposals · ${retired.length} retired\n`;
              text += `📈 Patterns: ${patternCount} traced · ${candidateCount} candidates\n`;
              text += `🔍 Threshold: ${threshold}x recurrences\n`;

              try {
                const vikingStatus = await checkVikingHealth();
                text += `🔮 OpenViking: ${vikingStatus.available ? "connected" : "not reachable"} (${vikingStatus.url})\n`;
              } catch { text += `🔮 OpenViking: check failed\n`; }

              const priority = getPriorityDomains(0.4);
              if (priority.length > 0) {
                text += `🎯 Priority gaps: ${priority.map(d => `${d.domain} (${Math.round(d.gapScore * 100)}%)`).join(", ")}\n`;
              }

              text += `\n`;

              if (active.length > 0) {
                text += `Active (${active.length}):\n`;
                for (const name of active) {
                  const stats = getSkillStats(name);
                  text += stats.activations > 0
                    ? `  ${name}: ${stats.activations} acts, ${Math.round(stats.successRate * 100)}% succ (${stats.daysSinceActivation ?? "?"}d ago)\n`
                    : `  ${name}: no activations yet\n`;
                }
              }

              if (proposals.length > 0) {
                text += `\nProposals (${proposals.length}):\n`;
                for (const name of proposals) text += `  ${name}: /forge approve ${name}\n`;
              }

              if (retired.length > 0) {
                text += `\nRetired (${retired.length}):\n`;
                for (const name of retired) text += `  ${name}: /forge reinstate ${name}\n`;
              }

              return { text };
            }

            // ── Core workflow ──
            case "approve": {
              if (!subArgs) return { text: "Usage: /forge approve <skill-name>" };
              return { text: (await validateAndDeploy(subArgs)).message };
            }
            case "reject": {
              if (!subArgs) return { text: "Usage: /forge reject <skill-name>" };
              const deleted = deleteProposal(subArgs);
              if (!deleted) return { text: `Proposal '${subArgs}' not found.` };
              notify(`Skill rejected: ${subArgs}`);
              return { text: `Skill '${subArgs}' rejected.` };
            }
            case "upgrade": {
              if (!subArgs) return { text: "Usage: /forge upgrade <skill-name>" };
              const oldName = subArgs;
              const upgradeName = oldName + "-upgrade";
              const upgradeDir = path.join(PROPOSALS_DIR, upgradeName);
              if (!fs.existsSync(upgradeDir)) return { text: `No upgrade proposal for '${oldName}'.` };

              // H5 fix: validate upgrade SKILL.md BEFORE retiring the old skill
              try {
                const { validateSkillMd: validateUpgrade } = await import("./src/skill/validator.js");
                const upgradeMdPath = path.join(upgradeDir, "SKILL.md");
                if (fs.existsSync(upgradeMdPath)) {
                  const upgradeMd = fs.readFileSync(upgradeMdPath, "utf-8");
                  const valResult = validateUpgrade(upgradeMd, upgradeName);
                  if (valResult.errors.some((e: string) => e.startsWith("BLOCKED:"))) {
                    const blockReasons = valResult.errors.filter((e: string) => e.startsWith("BLOCKED:")).join("; ");
                    fs.rmSync(upgradeDir, { recursive: true, force: true });
                    notify(`Upgrade blocked: ${upgradeName} — ${blockReasons}`);
                    return { text: `Upgrade '${upgradeName}' blocked by validator: ${blockReasons}` };
                  }
                }
              } catch { /* validator import failed — proceed with caution */ }

              if (fs.existsSync(path.join(SKILLS_DIR, oldName))) { retireSkill(oldName); }
              const targetDir = path.join(SKILLS_DIR, oldName);
              fs.mkdirSync(targetDir, { recursive: true });
              for (const file of fs.readdirSync(upgradeDir)) fs.copyFileSync(path.join(upgradeDir, file), path.join(targetDir, file));
              fs.rmSync(upgradeDir, { recursive: true, force: true });
              recordActivation(oldName, true);
              const toolMatch = oldName.match(/^(.+?)(?:-guard|-skill|-v\d+|-rev\d+)?$/);
              if (toolMatch) recordDeploymentBaseline(oldName, toolMatch[1]);
              notify(`Skill upgraded: ${oldName}`);
              try { buildCapabilityTree(); } catch {}
              return { text: `Skill '${oldName}' upgraded.` };
            }
            case "rollback": {
              if (!subArgs) return { text: "Usage: /forge rollback <skill-name>" };
              const retiredDir = path.join(FORGE_DIR, "retired", subArgs);
              if (!fs.existsSync(retiredDir)) return { text: `No retired version of '${subArgs}'.` };

              // M10 fix: validate retired SKILL.md before deleting active version
              const retiredMdPath = path.join(retiredDir, "SKILL.md");
              if (fs.existsSync(retiredMdPath)) {
                try {
                  const { validateSkillMd: validateRollback } = await import("./src/skill/validator.js");
                  const retiredMd = fs.readFileSync(retiredMdPath, "utf-8");
                  const valResult = validateRollback(retiredMd, subArgs);
                  if (valResult.errors.some((e: string) => e.startsWith("BLOCKED:"))) {
                    return { text: `Rollback aborted: retired version of '${subArgs}' fails security validation. Both versions preserved.` };
                  }
                } catch { /* validator import failed — proceed */ }
              }

              if (fs.existsSync(path.join(SKILLS_DIR, subArgs))) fs.rmSync(path.join(SKILLS_DIR, subArgs), { recursive: true, force: true });
              const done = reinstateSkill(subArgs);
              if (!done) return { text: `Rollback failed for '${subArgs}'.` };
              notify(`Skill rolled back: ${subArgs}`);
              return { text: `Skill '${subArgs}' rolled back.` };
            }
            case "retire": {
              if (!subArgs) return { text: "Usage: /forge retire <skill-name>" };
              const done = retireSkill(subArgs);
              if (!done) return { text: `Skill '${subArgs}' not found.` };
              notify(`Skill retired: ${subArgs}`);
              try { buildCapabilityTree(); } catch {}
              return { text: `Skill '${subArgs}' retired.` };
            }
            case "reinstate": {
              if (!subArgs) return { text: "Usage: /forge reinstate <skill-name>" };
              const done = reinstateSkill(subArgs);
              if (!done) return { text: `Retired skill '${subArgs}' not found.` };
              notify(`Skill reinstated: ${subArgs}`);
              return { text: `Skill '${subArgs}' reinstated.` };
            }

            // ── Diagnostics ──
            case "quality": {
              if (!subArgs) return { text: "Usage: /forge quality <skill-name>" };
              const skillFile = path.join(SKILLS_DIR, subArgs, "SKILL.md");
              if (!fs.existsSync(skillFile)) return { text: `Skill '${subArgs}' not found.` };
              const skillMd = fs.readFileSync(skillFile, "utf-8");
              const toolName = subArgs.replace(/-(guard|skill|v\d+|rev\d+|upgrade)$/, "");
              return { text: formatQualityReport(scoreSkill(skillMd, toolName), subArgs) };
            }
            case "gaps":
              return { text: buildUnifiedGapReport() };
            case "gap_propose":
            case "propose_gaps": {
              const gaps = detectGaps();
              if (gaps.length === 0) return { text: "No gaps to address." };
              resetLlmRateLimit();
              await analyzePatterns();
              return { text: `${gaps.length} gaps evaluated. Check /forge for proposals.` };
            }
            case "watchdog": {
              const alerts = runEffectivenessWatchdog();
              if (alerts.length === 0) return { text: "All skills performing at or above baseline." };
              let text = `Effectiveness Report\n\n${alerts.length} flagged:\n\n`;
              for (const a of alerts) {
                text += `${a.reason === "degraded" ? "🔴" : "🟡"} ${a.skill}: ${a.reason === "no_improvement"
                  ? `${Math.round(a.successRate * 100)}% vs ${Math.round(a.baselineRate * 100)}% baseline (${a.activations} acts)`
                  : `${Math.round(a.successRate * 100)}% success (${a.activations} acts)`}\n`;
              }
              return { text };
            }
            case "list": {
              const active = listActiveSkills();
              const proposals = listProposals();
              const retired = listRetiredSkills();
              let text = "AceForge Inventory\n\n";
              text += `Active (${active.length}):\n${active.length === 0 ? "  none\n" : active.map(s => `  ✓ ${s}`).join("\n") + "\n"}`;
              text += `\nProposals (${proposals.length}):\n${proposals.length === 0 ? "  none\n" : proposals.map(s => `  ◌ ${s}`).join("\n") + "\n"}`;
              text += `\nRetired (${retired.length}):\n${retired.length === 0 ? "  none\n" : retired.map(s => `  ✗ ${s}`).join("\n") + "\n"}`;
              return { text };
            }

            // ── Phase 2: Intelligence ──
            case "tree":
              return { text: formatCapabilityTree() };
            case "cross_session":
              return { text: formatCrossSessionReport() };
            case "compose":
              return { text: formatCompositionReport() };
            case "behavior_gaps":
              return { text: formatBehaviorGapReport() };
            case "optimize":
              return { text: formatOptimizationReport() };

            // ── Phase 3: Validation ──
            case "test": {
              const results = await runAllHealthTests();
              return { text: formatHealthTestReport(results) };
            }
            case "challenge": {
              const challenges = await generateChallenges();
              return { text: formatChallengeReport(challenges) };
            }
            case "adversarial":
              return { text: formatAdversarialReport() };

            // ── Help ──
            case "help":
              return { text: [
                "AceForge Commands\n",
                "Core:",
                "  /forge                — Dashboard (status + skills + gaps)",
                "  /forge approve <n>    — Deploy a proposed skill",
                "  /forge reject <n>     — Reject a proposal",
                "  /forge upgrade <n>    — Deploy upgrade, retire old",
                "  /forge rollback <n>   — Undo an upgrade",
                "  /forge retire <n>     — Retire an active skill",
                "  /forge reinstate <n>  — Bring back a retired skill",
                "",
                "Diagnostics:",
                "  /forge list           — Full inventory",
                "  /forge quality <n>    — Score a skill against usage data",
                "  /forge gaps           — All capability gaps",
                "  /forge watchdog       — Effectiveness check",
                "",
                "Intelligence:",
                "  /forge tree           — Capability tree with gap scores",
                "  /forge cross_session  — Cross-session patterns",
                "  /forge compose        — Skill co-activation analysis",
                "  /forge behavior_gaps  — Fallback/deferral detection",
                "  /forge optimize       — Description mismatch report",
                "",
                "Validation:",
                "  /forge test           — Health tests on deployed skills",
                "  /forge challenge      — Grounded challenge scenarios",
                "  /forge adversarial    — Adversarial mutation suite",
              ].join("\n") };

            default:
              return { text: `Unknown subcommand: '${sub}'. Run /forge help for available commands.` };
          }
        }
      });

      log.info("[aceforge] v0.7.5 — all hooks, tools, and commands registered (Phase 1 + 2 + 3)");
    }
  };
}

// ─── H4 fix: shared gap report builder used by both tool and command ────
function buildUnifiedGapReport(): string {
  const gaps = detectGaps();
  const behaviorGaps = summarizeBehaviorGaps();
  const crossSession = getCrossSessionCandidates();

  if (gaps.length === 0 && behaviorGaps.length === 0 && crossSession.length === 0) {
    return "No capability gaps detected.";
  }

  let text = `AceForge Gap Analysis\n\n`;

  if (gaps.length > 0) {
    text += `Tool Gaps (${gaps.length}):\n`;
    for (const gap of gaps) {
      const sev = gap.severity >= 12 ? "HIGH" : gap.severity >= 6 ? "MEDIUM" : "LOW";
      text += `  ${gap.tool} (${sev}): ${gap.gapType.replace(/_/g, " ")}\n`;
      text += `    ${gap.evidence.slice(0, 2).join("; ")}\n`;
    }
    text += `\n`;
  }

  if (behaviorGaps.length > 0) {
    text += `Behavior Gaps (${behaviorGaps.length}):\n`;
    for (const bg of behaviorGaps.slice(0, 5)) {
      const icon = bg.gapType === "fallback" ? "🔴" : bg.gapType === "deferral" ? "🟡" : "🟠";
      text += `  ${icon} ${bg.domain}: ${bg.gapType} (${bg.count}x)\n`;
    }
    text += `\n`;
  }

  if (crossSession.length > 0) {
    text += `Cross-Session Candidates (${crossSession.length}):\n`;
    for (const cs of crossSession.slice(0, 5)) {
      text += `  ${cs.tool}: ${cs.detail}\n`;
    }
    text += `\n`;
  }

  text += `Generate remediation: /forge gap_propose`;
  return text;
}

export default buildPlugin();
