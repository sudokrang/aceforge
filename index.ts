/**
 * AceForge — Self-Evolving Skill Engine for OpenClaw
 * v0.9.0: Evolution engine — trace distillation, novel capture, /forge evolve — replaced 20 commands with subcommand dispatch — C1/H1/H2/H3/H4/H5/M7 applied
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
import { bold, mono, metric } from "./src/notify-format.js";

// Formatting helper for action notifications — module scope so validateAndDeploy can use it
const _skillAction = (icon: string, verb: string, name: string): string =>
  `${icon} ${bold(verb)}  ${mono(name)}`;
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
  getSkillMaturity,
  checkMaturityTransition,
  runMaturityChecks,
  runApoptosisChecks,
} from "./src/skill/lifecycle.js";
import { checkVikingHealth } from "./src/viking/client.js";
import { scoreSkill, formatQualityReport } from "./src/skill/quality-score.js";
import { detectGaps } from "./src/pattern/gap-detect.js";
import { NATIVE_TOOLS } from "./src/pattern/constants.js";

// ─── Phase 2 imports ────────────────────────────────────────────────────
import { buildCapabilityTree, formatCapabilityTree, getPriorityDomains } from "./src/intelligence/capability-tree.js";
import { mergePatterns, formatCrossSessionReport, getCrossSessionCandidates } from "./src/intelligence/cross-session.js";
import { formatCompositionReport, proposeCompositionSkills } from "./src/intelligence/composition.js";
import { summarizeBehaviorGaps, formatBehaviorGapReport, updateTreeWithBehaviorGaps } from "./src/intelligence/proactive-gaps.js";
import { formatOptimizationReport } from "./src/intelligence/description-optimizer.js";
import { handleCorrectionForSkill } from "./src/intelligence/auto-adjust.js";
import { recordRevision, formatHistoryTimeline, formatDiff as formatSkillDiff } from "./src/skill/history.js";

// ─── Phase 3 imports ────────────────────────────────────────────────────
import { runAllHealthTests, formatHealthTestReport } from "./src/validation/health-test.js";
import { generateChallenges, formatChallengeReport } from "./src/validation/grounded-challenges.js";
import { runAdversarialTests, formatAdversarialReport } from "./src/validation/adversarial.js";

// ─── Phase 4 imports (v0.9.0 Evolution Engine) ─────────────────────────────────
import { distillNewTraces, formatDistillationReport, formatDistillationNotification } from "./src/evolution/distill.js";
import { promoteCapture, dismissCapture, formatCapturesReport } from "./src/evolution/capture-novel.js";
import { executeEvolve, formatEvolveResult } from "./src/evolution/evolve-command.js";

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
        notify(`🚫 ${bold("Skill blocked")}  ${mono(skillName)}\n\nFailed security validation — not deployed.\n${blockReasons.replace(/BLOCKED:\s*/g, "")}`);
        return { ok: false, message: `Skill '${skillName}' blocked by validator: ${blockReasons}` };
      }
      notify(`⚠️ ${bold("Deployed with warnings")}  ${mono(skillName)}\n\n${result.errors.join("\n")}`);

    }
  } catch (err) { fs.rmSync(path.join(SKILLS_DIR, skillName), { recursive: true, force: true }); return { ok: false, message: `Skill '${skillName}' rejected: validator failed to load — ${(err as Error).message}` }; }

  recordActivation(skillName, true);
  const toolMatch = skillName.match(/^(.+?)(?:-guard|-skill|-v\d+|-rev\d+)?$/);
  if (toolMatch) recordDeploymentBaseline(skillName, toolMatch[1]);

  // Rebuild capability tree after deployment
  try { buildCapabilityTree(); } catch { /* non-critical */ }

  // Record in version history
  try {
    const deployedMd = fs.readFileSync(path.join(SKILLS_DIR, skillName, "SKILL.md"), "utf-8");
    recordRevision(skillName, deployedMd, "deploy", "Deployed via /forge approve");
  } catch { /* non-critical */ }

  // Multi-agent: optionally deploy to shared skills directory too
  if (process.env.ACEFORGE_SHARED_SKILLS === "true") {
    const sharedDir = path.join(HOME, ".openclaw", "skills", skillName);
    try {
      fs.mkdirSync(sharedDir, { recursive: true });
      const skillFiles = fs.readdirSync(path.join(SKILLS_DIR, skillName));
      for (const file of skillFiles) {
        fs.copyFileSync(path.join(SKILLS_DIR, skillName, file), path.join(sharedDir, file));
      }
      console.log(`[aceforge] shared skill deployed: ${skillName} → ~/.openclaw/skills/`);
    } catch (err) {
      console.warn(`[aceforge] shared skill deploy failed: ${(err as Error).message}`);
    }
  }

  notify(_skillAction("✅", "Skill deployed", skillName));
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
          // NATIVE_TOOLS imported from src/pattern/constants.ts — canonical source
          try {
            const removed = revalidateProposals(NATIVE_TOOLS, notify);
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

          // Phase 2C: Composition execution — propose workflow skills from co-activations
          try {
            proposeCompositionSkills().catch(err =>
              log.error(`[aceforge] composition proposal error: ${(err as Error).message}`)
            );
          } catch (err) {
            log.error(`[aceforge] composition error: ${(err as Error).message}`);
          }

          // Phase 2D: Proactive behavior gap detection
          try {
            const behaviorGaps = summarizeBehaviorGaps();
            if (behaviorGaps.length > 0) {
              const criticalGaps = behaviorGaps.filter(g => g.count >= 5);
              if (criticalGaps.length > 0) {
                // Rate limit: max once per 24 hours
                const gapNotifyFile = path.join(FORGE_DIR, ".last-gap-notify");
                const GAP_NOTIFY_INTERVAL = 24 * 60 * 60 * 1000;
                let shouldNotifyGaps = true;
                try {
                  if (fs.existsSync(gapNotifyFile)) {
                    const last = new Date(fs.readFileSync(gapNotifyFile, "utf-8").trim()).getTime();
                    if (Date.now() - last < GAP_NOTIFY_INTERVAL) shouldNotifyGaps = false;
                  }
                } catch { /* first run */ }

                if (shouldNotifyGaps) {
                // Build human-readable notification per gap
                const gapMessages: string[] = [];
                for (const g of criticalGaps) {
                  // Translate internal type to plain language
                  const what: Record<string, string> = {
                    fallback: "couldn't handle",
                    deferral: "asked permission instead of acting on",
                    uncertainty: "was unsure about",
                    infrastructure: "lacked tools/access for",
                  };
                  const verb = what[g.gapType] || "struggled with";

                  let msg = `Your agent ${verb} ${bold(String(g.count))} ${g.domain} tasks`;

                  // Show 1-2 real examples so the user understands what happened
                  if (g.examples && g.examples.length > 0) {
                    const exLines = g.examples.slice(0, 2).map((ex: string) => `  "${ex.slice(0, 70)}"`).join("\n");
                    msg += `\n\nIt said things like:\n${exLines}`;
                  }

                  // Actionable suggestion + commands
                  if (g.suggestedAction) {
                    msg += `\n\n${g.suggestedAction}`;
                  }

                  // Always show next-step commands
                  msg += `\n\n${mono("/forge gaps")} — full gap details`;
                  msg += `\n${mono("/forge behavior_gaps")} — all behavior patterns`;

                  gapMessages.push(msg);
                }

                notify(
                  `🔍 ${bold("Agent Behavior Gap")}\n\n` +
                  gapMessages.join("\n\n")
                ).catch(() => {});
                try { fs.writeFileSync(gapNotifyFile, new Date().toISOString()); } catch { /* non-critical */ }
                } // end shouldNotifyGaps
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

          // Phase 4: Maturity stage transitions
          try {
            const transitions = runMaturityChecks();
            for (const t of transitions) {
              notify(
                `🟣 ${bold("Maturity Promotion")}  ${mono(t.skill)}\n` +
                `→ ${t.transition}\n` +
                `50+ activations · 75%+ success · 14+ days`
              ).catch(() => {});
              log.info(`[aceforge] maturity: ${t.skill} promoted to ${t.transition}`);
            }
          } catch (err) {
            log.error(`[aceforge] maturity check error: ${(err as Error).message}`);
          }

          // Phase 4: Apoptosis detection
          try {
            const signals = runApoptosisChecks();
            for (const s of signals) {
              notify(
                `💀 ${bold("Apoptosis Signal")}  ${mono(s.skill)}\n` +
                `${s.reason.replace(/_/g, " ")}\n` +
                `${s.detail}\n\n` +
                `${mono("/forge retire " + s.skill)}`
              ).catch(() => {});
              log.warn(`[aceforge] apoptosis: ${s.skill} — ${s.reason}: ${s.detail}`);
            }
          } catch (err) {
            log.error(`[aceforge] apoptosis check error: ${(err as Error).message}`);
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
          notify(`📋 ${bold("Skill proposed")}  ${mono(name as string)}\n${category}\n\n${mono("/forge approve " + (name as string))}`);
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
          notify(_skillAction("❌", "Skill rejected", skillName));
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

              let text = `⚡ ${bold("AceForge v" + getPluginVersion())}\n\n`;
              text += `${metric("Skills", `${active.length} active · ${proposals.length} pending · ${retired.length} retired`)}\n`;
              text += `${metric("Traces", `${patternCount} patterns · ${candidateCount} candidates`)}\n`;
              text += `${metric("Threshold", `${threshold}× recurrences`)}\n`;

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
                  const maturity = getSkillMaturity(name);
                  const mBadge = maturity === "mature" ? "🟣" : maturity === "committed" ? "🔵" : "⚪";
                  text += stats.activations > 0
                    ? `  ${mBadge} ${name} [${maturity}]: ${stats.activations} acts, ${Math.round(stats.successRate * 100)}% succ (${stats.daysSinceActivation ?? "?"}d ago)\n`
                    : `  ${mBadge} ${name} [${maturity}]: no activations yet\n`;
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
              if (!subArgs) return { text: "Usage: /forge reject <skill-name>  or  /forge reject all" };
              if (subArgs === "all") {
                const allProposals = listProposals();
                if (allProposals.length === 0) return { text: "No proposals to reject." };
                for (const p of allProposals) deleteProposal(p);
                notify(`❌ ${bold("Bulk rejected")}  ${allProposals.length} proposals`);
                return { text: `Rejected all ${allProposals.length} proposals: ${allProposals.join(", ")}` };
              }
              const deleted = deleteProposal(subArgs);
              if (!deleted) return { text: `Proposal '${subArgs}' not found.` };
              notify(_skillAction("❌", "Skill rejected", subArgs));
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
                    notify(`🚫 ${bold("Upgrade blocked")}  ${mono(upgradeName)}\n\nFailed security validation — old skill preserved.\n${blockReasons.replace(/BLOCKED:\s*/g, "")}`);

                    return { text: `Upgrade '${upgradeName}' blocked by validator: ${blockReasons}` };
                  }
                }
              } catch (err) { return { text: `Upgrade aborted: validator failed to load — ${(err as Error).message}` }; }

              if (fs.existsSync(path.join(SKILLS_DIR, oldName))) { retireSkill(oldName); }
              const targetDir = path.join(SKILLS_DIR, oldName);
              fs.mkdirSync(targetDir, { recursive: true });
              for (const file of fs.readdirSync(upgradeDir)) fs.copyFileSync(path.join(upgradeDir, file), path.join(targetDir, file));
              fs.rmSync(upgradeDir, { recursive: true, force: true });
              recordActivation(oldName, true);
              const toolMatch = oldName.match(/^(.+?)(?:-guard|-skill|-v\d+|-rev\d+)?$/);
              if (toolMatch) recordDeploymentBaseline(oldName, toolMatch[1]);
              notify(_skillAction("⬆️", "Skill upgraded", oldName));
              try { buildCapabilityTree(); } catch {}
              try {
                const upgradedMd = fs.readFileSync(path.join(SKILLS_DIR, oldName, "SKILL.md"), "utf-8");
                recordRevision(oldName, upgradedMd, "upgrade", `Upgraded from ${upgradeName}`);
              } catch { /* non-critical */ }
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
                } catch (err) { return { text: `Rollback aborted: validator failed to load — ${(err as Error).message}` }; }
              }

              if (fs.existsSync(path.join(SKILLS_DIR, subArgs))) fs.rmSync(path.join(SKILLS_DIR, subArgs), { recursive: true, force: true });
              const done = reinstateSkill(subArgs);
              if (!done) return { text: `Rollback failed for '${subArgs}'.` };
              try {
                const rolledMd = fs.readFileSync(path.join(SKILLS_DIR, subArgs, "SKILL.md"), "utf-8");
                recordRevision(subArgs, rolledMd, "rollback", "Rolled back via /forge rollback");
              } catch { /* non-critical */ }
              notify(_skillAction("↩️", "Skill rolled back", subArgs));
              return { text: `Skill '${subArgs}' rolled back.` };
            }
            case "retire": {
              if (!subArgs) return { text: "Usage: /forge retire <skill-name>" };
              const done = retireSkill(subArgs);
              if (!done) return { text: `Skill '${subArgs}' not found.` };
              notify(_skillAction("🛑", "Skill retired", subArgs));
              try { buildCapabilityTree(); } catch {}
              return { text: `Skill '${subArgs}' retired.` };
            }
            case "reinstate": {
              if (!subArgs) return { text: "Usage: /forge reinstate <skill-name>" };
              const done = reinstateSkill(subArgs);
              if (!done) return { text: `Retired skill '${subArgs}' not found.` };
              notify(_skillAction("♻️", "Skill reinstated", subArgs));
              return { text: `Skill '${subArgs}' reinstated.` };
            }

            // ── Diagnostics ──
            case "quality": {
              if (!subArgs) return { text: "Usage: /forge quality <skill-name>" };
              let qualityFile = path.join(SKILLS_DIR, subArgs, "SKILL.md");
              let qualitySource = "deployed";
              if (!fs.existsSync(qualityFile)) {
                qualityFile = path.join(PROPOSALS_DIR, subArgs, "SKILL.md");
                qualitySource = "proposal";
              }
              if (!fs.existsSync(qualityFile)) return { text: `Skill '${subArgs}' not found in deployed skills or proposals.` };
              const skillMd = fs.readFileSync(qualityFile, "utf-8");
              const toolName = subArgs.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow)$/, "").replace(/-(docker|ssh|nas|git|npm|python|http|config|code|docs|data|logs|openclaw|systemd|k8s|archive|search|brew|apt|netsuite)$/, "");
              const qReport = scoreSkill(skillMd, toolName);
              let qText = `[${qualitySource.toUpperCase()}] ` + formatQualityReport(qReport, subArgs);
              if (qualitySource === "proposal") {
                const rec = qReport.combined >= 70 ? "\u2705 Recommend: approve"
                  : qReport.combined >= 50 ? "\u26a0\ufe0f Borderline: review carefully"
                  : "\u274c Recommend: reject";
                qText += `\n${rec}`;
              }
              return { text: qText };
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
              text += `Active (${active.length}):\n${active.length === 0 ? "  none\n" : active.map(s => {
                const m = getSkillMaturity(s);
                const badge = m === "mature" ? "🟣" : m === "committed" ? "🔵" : "⚪";
                return `  ${badge} ${s} [${m}]`;
              }).join("\n") + "\n"}`;
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
              return { text: "⚠️ Experimental: Composition detection identifies co-activation candidates.\nDAG orchestration is not yet implemented.\n\n" + formatCompositionReport() };
            case "behavior_gaps":
              return { text: formatBehaviorGapReport() };
            case "optimize":
              return { text: formatOptimizationReport() };

            // ── Version History ──
            case "history": {
              if (!subArgs) return { text: "Usage: /forge history <skill-name>" };
              return { text: formatHistoryTimeline(subArgs) };
            }
            case "diff": {
              if (!subArgs) return { text: "Usage: /forge diff <skill-name> [version]" };
              const diffParts = subArgs.split(/\s+/);
              const diffName = diffParts[0];
              const diffVersion = diffParts[1] ? parseInt(diffParts[1], 10) : undefined;
              if (diffParts[1] && (isNaN(diffVersion!) || diffVersion! < 1)) {
                return { text: `Invalid version number: '${diffParts[1]}'. Use: /forge history ${diffName}` };
              }
              return { text: formatSkillDiff(diffName, diffVersion) };
            }

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

            // ── Phase 4: Evolution (v0.9.0) ──
            case "evolve": {
              if (!subArgs) return { text: "Usage: /forge evolve <skill-name>\nTriggers trace distillation + LLM revision with unified diff." };
              const evolveResult = await executeEvolve(subArgs, async (prompt: string) => {
                try {
                  const { callGeneratorRaw } = await import("./src/skill/llm-generator.js");
                  return await callGeneratorRaw(prompt);
                } catch { return null; }
              });
              return { text: formatEvolveResult(evolveResult) };
            }
            case "distill": {
              if (!subArgs) return { text: "Usage: /forge distill <skill-name>\nRuns SRLR trace distillation without LLM revision." };
              const healthFile2 = path.join(FORGE_DIR, "skill-health.jsonl");
              let distillActivations = 0;
              if (fs.existsSync(healthFile2)) {
                const dLines = fs.readFileSync(healthFile2, "utf-8").split("\n").filter((l: string) => l.trim());
                for (const dl of dLines) {
                  try { const de = JSON.parse(dl); if (de.skill === subArgs && de.action === "activation") distillActivations++; } catch { /* skip */ }
                }
              }
              const distillReport = distillNewTraces(subArgs, Math.max(50, distillActivations));
              if (!distillReport) return { text: `No trace data available for '${subArgs}'.` };
              return { text: formatDistillationReport(distillReport) };
            }
            case "captures":
              return { text: formatCapturesReport() };
            case "capture": {
              if (!subArgs) return { text: "Usage: /forge capture promote|dismiss <tool>" };
              const capParts = subArgs.split(/\s+/);
              const capAction = capParts[0];
              const capTool = capParts.slice(1).join(" ");
              if (!capTool) return { text: "Usage: /forge capture promote|dismiss <tool>" };
              if (capAction === "promote") {
                const promoted = promoteCapture(capTool);
                return { text: promoted ? `Capture '${capTool}' promoted — included in next crystallization cycle.` : `No pending capture for '${capTool}'.` };
              }
              if (capAction === "dismiss") {
                const dismissed = dismissCapture(capTool);
                return { text: dismissed ? `Capture '${capTool}' dismissed.` : `No pending capture for '${capTool}'.` };
              }
              return { text: "Unknown capture action. Use: promote or dismiss" };
            }

            // ── Preview: human-readable skill brief for non-technical users ──
            case "preview": {
              if (!subArgs) return { text: "Usage: /forge preview <name>" };
              let previewFile = path.join(PROPOSALS_DIR, subArgs, "SKILL.md");
              let previewSource = "PROPOSAL";
              if (!fs.existsSync(previewFile)) {
                previewFile = path.join(SKILLS_DIR, subArgs, "SKILL.md");
                previewSource = "INSTALLED";
              }
              if (!fs.existsSync(previewFile)) return { text: `'${subArgs}' not found in proposals or installed skills.` };
              const md = fs.readFileSync(previewFile, "utf-8");

              // ── Extract "What this skill does" from description ──
              const descMatch = md.match(/^description:\s*["']?(.+?)["']?$/m);
              const description = descMatch ? descMatch[1].trim() : "";

              // Build a plain-english summary from the description
              // Capitalize first letter, ensure it reads as a sentence
              let whatItDoes = description;
              if (whatItDoes && !whatItDoes.endsWith(".")) whatItDoes += ".";
              if (whatItDoes) whatItDoes = whatItDoes.charAt(0).toUpperCase() + whatItDoes.slice(1);

              // ── Extract "What it will improve" from instructions/steps ──
              // Look for ### headings inside Instructions section, or numbered steps
              const capabilities: string[] = [];
              // Strategy 1: Find ### sub-headings (e.g., "### View Current Config")
              const subHeadings = md.match(/^###\s+(?:\d+\.?\s*)?(.+)$/gm);
              if (subHeadings) {
                for (const h of subHeadings.slice(0, 6)) {
                  const clean = h.replace(/^###\s+(?:\d+\.?\s*)?/, "").trim();
                  // Skip meta-headings
                  if (/when to use|pre.?flight|error|anti.?pattern|instructions/i.test(clean)) continue;
                  if (clean.length > 3 && clean.length < 80) capabilities.push(clean);
                }
              }
              // Strategy 2: If no sub-headings, look for bullet points under Instructions
              if (capabilities.length === 0) {
                const instrSection = md.match(/##\s*Instructions[\s\S]*?(?=\n##\s|$)/i);
                if (instrSection) {
                  const bullets = instrSection[0].match(/^\s*[-*]\s+(.{10,80})$/gm);
                  if (bullets) {
                    for (const b of bullets.slice(0, 5)) {
                      capabilities.push(b.replace(/^\s*[-*]\s+/, "").replace(/\*\*/g, "").trim());
                    }
                  }
                }
              }

              // ── Extract "Mistakes it will prevent" from anti-patterns ──
              const mistakes: string[] = [];
              const antiSection = md.match(/##\s*Anti[- ]?Patterns[\s\S]*?(?=\n##\s|$)/i);
              if (antiSection) {
                const bullets = antiSection[0].match(/^\s*[-*]\s+\*\*.+\*\*.*$/gm);
                if (bullets) {
                  for (const b of bullets.slice(0, 5)) {
                    // Extract everything after the closing ** — that's the actual mistake
                    let clean = b.replace(/^\s*[-*]\s+\*\*[^*]+\*\*\s*/, "").trim();
                    // If nothing after **, the entire bold text IS the content (e.g., "**Do not pass path with raw**")
                    if (clean.length < 4) {
                      clean = b.replace(/^\s*[-*]\s+\*\*/, "").replace(/\*\*.*$/, "").trim();
                    }
                    // Strip leading connectors and "Never"/"Do not" prefixes
                    clean = clean.replace(/^[-—:,]\s*/, "");
                    clean = clean.replace(/^[Nn]ever\s+/, "").replace(/^[Dd]o\s+not\s+/, "").replace(/^[Dd]on't\s+/, "");
                    // Strip trailing " — causes X errors" explanations for cleaner display
                    clean = clean.replace(/\s*[-—]\s+(?:this|causes|which|because).*$/i, "");
                    if (clean.length > 3) mistakes.push(clean.charAt(0).toUpperCase() + clean.slice(1));
                  }
                }
              }
              // Fallback: look for "Never" bullets anywhere
              if (mistakes.length === 0) {
                const neverBullets = md.match(/^\s*[-*]\s+\*\*[Nn]ever\*\*\s+.{5,}/gm);
                if (neverBullets) {
                  for (const b of neverBullets.slice(0, 4)) {
                    let clean = b.replace(/^\s*[-*]\s+\*\*[Nn]ever\*\*\s+/, "").trim();
                    // Strip trailing explanation after dash
                    clean = clean.replace(/\s*[-—]\s+(?:this|causes|which|because).*$/i, "");
                    if (clean.length > 3) mistakes.push(clean.charAt(0).toUpperCase() + clean.slice(1));
                  }
                }
              }

              // ── Extract error recovery topics ──
              const recoveries: string[] = [];
              const errorSection = md.match(/##\s*Error\s+Recovery[\s\S]*?(?=\n##\s|$)/i);
              if (errorSection) {
                // Look for error names in table rows or bold text
                const errorNames = errorSection[0].match(/`([^`]{3,40})`/g);
                if (errorNames) {
                  for (const e of errorNames.slice(0, 3)) {
                    recoveries.push(e.replace(/`/g, ""));
                  }
                }
              }

              // ── Trace provenance from candidates.jsonl ──
              let traceCount = "";
              let traceSessions = "";
              let traceSuccess = "";
              let traceType = "";
              try {
                const candFile = path.join(FORGE_DIR, "candidates.jsonl");
                if (fs.existsSync(candFile)) {
                  const lines = fs.readFileSync(candFile, "utf-8").trim().split("\n").filter(Boolean);
                  const toolName = subArgs.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow)$/, "").replace(/-(docker|ssh|nas|git|npm|python|http|config|code|docs|data|logs|openclaw|systemd|k8s|archive|search|brew|apt|netsuite)$/, "");
                  for (let i = lines.length - 1; i >= 0; i--) {
                    try {
                      const c = JSON.parse(lines[i]);
                      if (c.tool === toolName || c.tool === subArgs || (c.canonicalName && c.canonicalName === subArgs)) {
                        traceCount = String(c.occurrences || "?");
                        traceSessions = String(c.distinct_sessions || "?");
                        traceSuccess = String(Math.round((c.success_rate || 0) * 100));
                        traceType = c.type || "";
                        break;
                      }
                    } catch { /* skip */ }
                  }
                }
              } catch { /* no candidates file */ }

              // ── Readiness checks ──
              const hasWhenToUse = /##?\s*when\s+to\s+use/i.test(md);
              const hasInstructions = /##?\s*(instructions|steps|how\s+to|usage|workflow)/i.test(md);
              const hasErrorRecovery = /##?\s*(error\s+recovery|troubleshoot|when\s+.+\s+fails)/i.test(md);
              const hasAntiPatterns = /##?\s*anti[- ]?patterns/i.test(md);
              const sectionCount = [hasWhenToUse, hasInstructions, hasErrorRecovery, hasAntiPatterns].filter(Boolean).length;

              const structureOk = sectionCount >= 3;
              const evidenceStrong = parseInt(traceCount) >= 10 && parseInt(traceSessions) >= 2;
              const evidenceModerate = parseInt(traceCount) >= 5;

              // ── For deployed skills: show activation data instead ──
              let activationInfo = "";
              if (previewSource === "INSTALLED") {
                try {
                  const stats = getSkillStats(subArgs);
                  if (stats && stats.activations > 0) {
                    activationInfo = `\n  \u2500\u2500 Performance since install \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                    activationInfo += `  ${stats.activations} activations, ${Math.round(stats.successRate * 100)}% success rate\n`;
                    if (stats.activations >= 20) {
                      activationInfo += `  \u2705 Proven \u2014 enough data to measure real effectiveness\n`;
                    } else {
                      activationInfo += `  \u26a0\ufe0f Still early \u2014 need ${20 - stats.activations} more activations for reliable data\n`;
                    }
                  }
                } catch { /* lifecycle not available */ }
              }

              // ── Build the output ──
              let t = `${subArgs} [${previewSource}]\n\n`;

              // ── Maturity stage ──
              if (previewSource === "INSTALLED") {
                const maturity = getSkillMaturity(subArgs);
                const mIcon = maturity === "mature" ? "\u2705 Mature" : maturity === "committed" ? "\u2139\ufe0f Committed" : "\u26a0\ufe0f Progenitor";
                t += `\n  \u2500\u2500 Maturity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                t += `  ${mIcon}\n`;
                if (maturity === "committed") {
                  const mStats = getSkillStats(subArgs);
                  const needed = 50 - mStats.activations;
                  if (needed > 0) t += `  ${needed} more activations + 75% success + 14d to reach mature\n`;
                  else t += `  Checking success rate and deployment age for promotion...\n`;
                }
              }

              // What this skill does
              if (whatItDoes) {
                t += `  \u2500\u2500 What this skill does \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                t += `  ${whatItDoes}\n`;
              }

              // What it will improve
              if (capabilities.length > 0) {
                t += `\n  \u2500\u2500 What your agent will learn \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                for (const cap of capabilities.slice(0, 5)) t += `  \u2713 ${cap}\n`;
              }

              // Mistakes it will prevent
              if (mistakes.length > 0) {
                t += `\n  \u2500\u2500 Mistakes it will prevent \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                for (const m of mistakes.slice(0, 4)) t += `  \u2717 ${m}\n`;
              }

              // Error recovery
              if (recoveries.length > 0) {
                t += `\n  \u2500\u2500 Errors it knows how to handle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                for (const r of recoveries) t += `  \u21bb ${r}\n`;
              }

              // Why AceForge suggested this
              if (traceCount) {
                t += `\n  \u2500\u2500 Why this was suggested \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
                t += `  Your agent ran these commands ${traceCount} times across\n`;
                t += `  ${traceSessions} session(s) with ${traceSuccess}% success.\n`;
                if (traceType === "native-subpattern") {
                  t += `  This was the most common pattern for this tool.\n`;
                } else if (traceType === "evolution") {
                  t += `  This is an update to an existing skill based on new usage.\n`;
                } else if (traceType === "remediation") {
                  t += `  This addresses a gap where your agent struggled.\n`;
                }
              }

              // Activation data for deployed skills
              if (activationInfo) t += activationInfo;

              // Readiness
              t += `\n  \u2500\u2500 Is it ready? \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
              t += `  ${structureOk ? "\u2705" : "\u26a0\ufe0f"} ${structureOk ? "Well structured" : "Missing some sections"} \u2014 ${sectionCount}/4 recommended sections\n`;
              t += `  ${evidenceStrong ? "\u2705 Strong evidence" : evidenceModerate ? "\u26a0\ufe0f Some evidence" : "\u26a0\ufe0f Limited evidence"} \u2014 based on ${traceCount || "?"} real interactions\n`;
              if (previewSource === "PROPOSAL") {
                t += `  \u2139\ufe0f Effectiveness unknown until installed\n`;
              }

              // Actions
              t += `\n  /forge approve ${subArgs}  \u2502  /forge reject ${subArgs}`;
              if (previewSource === "PROPOSAL") {
                t += `\n  /forge quality ${subArgs}  \u2502  Full structural breakdown`;
              }
              return { text: t };
            }

                        // ── Filtered candidates ──
            case "filtered": {
              const filteredFile = path.join(FORGE_DIR, "filtered-candidates.jsonl");
              if (!fs.existsSync(filteredFile)) return { text: "No filtered candidates yet." };
              const content = fs.readFileSync(filteredFile, "utf-8").trim();
              if (!content) return { text: "No filtered candidates yet." };
              const entries = content.split("\n")
                .filter(l => l.trim())
                .map(l => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean)
                .slice(-30); // last 30

              if (entries.length === 0) return { text: "No filtered candidates yet." };

              // Group by reason
              const byReason = new Map<string, typeof entries>();
              for (const e of entries) {
                const r = e.reason || "unknown";
                if (!byReason.has(r)) byReason.set(r, []);
                byReason.get(r)!.push(e);
              }

              let text = `Filtered Candidates (last ${entries.length})\n\n`;
              for (const [reason, items] of byReason) {
                const label = reason.replace(/_/g, " ");
                text += `${label} (${items.length}):\n`;
                for (const item of items.slice(-5)) {
                  text += `  ${item.tool}: ${item.detail}\n`;
                }
                text += `\n`;
              }
              text += `Full log: ~/.openclaw/workspace/.forge/filtered-candidates.jsonl`;
              return { text };
            }

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
                "  /forge filtered      \u2014 What quality gates suppressed",
                "  /forge preview <n>   \u2014 Preview a skill before approving",
                "",
                "Intelligence:",
                "  /forge tree           — Capability tree with gap scores",
                "  /forge cross_session  — Cross-session patterns",
                "  /forge compose        — Skill co-activation analysis",
                "  /forge behavior_gaps  — Fallback/deferral detection",
                "  /forge optimize       — Description mismatch report",
                "",
                "Evolution:",
                "  /forge evolve <n>     — LLM revision with trace delta + unified diff",
                "  /forge distill <n>    — SRLR trace distillation report",
                "  /forge captures       — Novel one-shot success captures",
                "  /forge capture <act>  — promote or dismiss a capture",
                "",
                "History:",
                "  /forge history <n>    — Version history timeline",
                "  /forge diff <n> [v]   — Unified diff between versions",
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

      log.info("[aceforge] v0.9.4 — all hooks, tools, commands, and evolution engine registered ");
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
