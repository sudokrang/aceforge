/**
 * Pattern analysis engine — orchestrator
 *
 * v0.8.1: Refactored. Extracted to:
 *   - constants.ts     — all blocklists (canonical source, drift eliminated)
 *   - analyze-utils.ts — filesystem helpers (dedup checks, file readers)
 *   - analyze-native.ts — extractDomainPrefix, clusterNativeToolPatterns, native handler
 *   - analyze-chains.ts — analyzeChains (workflow skill proposals)
 *
 * This file remains the orchestrator: groupPatterns, 3-path analysis loop
 * (evolution → upgrade → new proposal), gap analysis wrapper.
 *
 * v0.7.2 fixes:
 *   N-M1: bundledTools dedup now parses YAML frontmatter (was trying JSON regex)
 *   N-M5: uses shared ACEFORGE_TOOL_BLOCKLIST
 */
import * as fsSync from "fs";
import * as path from "path";
import { appendJsonl } from "./store.js";
import { bold, mono, compose } from "../notify-format.js";
import { notify, flushDigest } from "../notify.js";
import { generateSkillFromCandidate, writeProposal } from "../skill/generator.js";
import { validateSkillMd } from "../skill/validator.js";
import { generateSkillWithLLm, reviseSkillWithLLm, generateRemediationSkillWithLLm } from "../skill/llm-generator.js";
import { detectGaps } from "./gap-detect.js";
import { scoreSkill } from "../skill/quality-score.js";
import { llmJudgeEvaluate } from "../skill/llm-judge.js";
import { getEffectiveCrystallizationThreshold, getHealthEntries } from "../skill/lifecycle.js";

// ─── Refactored imports ─────────────────────────────────────────────────
import {
  ACEFORGE_TOOL_BLOCKLIST, NATIVE_TOOLS,
  FORGE_DIR, SKILLS_DIR,
  THIRTY_DAYS_MS, SUCCESS_RATE_MIN,
  type PatternEntry,
} from "./constants.js";
import {
  readPatternsFile, readCandidatesFile,
  logFilteredCandidate,
  hasActiveProposalOrSkill, findDeployedSkill,
  hasProposalForSameTool, hasExistingProposal,
} from "./analyze-utils.js";
import { handleNativeToolCandidate } from "./analyze-native.js";
import { analyzeChains } from "./analyze-chains.js";

// Re-export extractDomainPrefix for backward compatibility
// (llm-generator.ts imports it from this path)
export { extractDomainPrefix } from "./analyze-native.js";

// ─── Pattern Grouping ───────────────────────────────────────────────────

function groupPatterns(patterns: PatternEntry[]): Map<string, PatternEntry[]> {
  const groups = new Map<string, PatternEntry[]>();
  const cutoff = Date.now() - THIRTY_DAYS_MS;

  for (const p of patterns) {
    if (p.type === "correction") continue;
    if (new Date(p.ts).getTime() < cutoff) continue;
    if (ACEFORGE_TOOL_BLOCKLIST.has(p.tool)) continue;

    const key = p.tool;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  for (const entries of groups.values()) {
    entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  }

  return groups;
}

// ─── Main Analysis Orchestrator ─────────────────────────────────────────

export async function analyzePatterns(): Promise<void> {
  console.log("[aceforge] running pattern analysis...");

  const patterns = readPatternsFile();
  if (patterns.length === 0) {
    console.log("[aceforge] no patterns to analyze");
    return;
  }

  const groups = groupPatterns(patterns);
  const effectiveThreshold = getEffectiveCrystallizationThreshold();

  if (effectiveThreshold > 3) {
    console.log(`[aceforge] diminishing returns active — threshold raised to ${effectiveThreshold}`);
  }

  const existingCandidates = readCandidatesFile();
  const existingCandidateTools = new Set(existingCandidates.map(c => c.tool));

  let newCandidates = 0;

  for (const [key, entries] of groups) {
    if (entries.length < effectiveThreshold) continue;

    // ═══ Native tool sub-pattern clustering ═══
    if (NATIVE_TOOLS.has(key)) {
      const handled = await handleNativeToolCandidate(key, entries, effectiveThreshold);
      if (handled) continue;
    }

    const sessions = new Set(entries.map(e => e.session).filter(Boolean));
    const successes = entries.filter(e => e.success).length;
    const successRate = successes / entries.length;

    // ═══ Path 1: Evolution — existing deployed skill with 50+ new traces ═══
    const deployedSkill = findDeployedSkill(key);
    if (deployedSkill) {
      // Try evolution first
      const healthEntries = getHealthEntries(deployedSkill);
      const baseline = healthEntries.find(e => e.action === "deployment_baseline");

      let evolutionProposed = false;

      if (baseline) {
        const tracesAtDeploy = (baseline as any).traceCountAtDeploy || 0;
        const newTraceCount = entries.length - tracesAtDeploy;

        if (newTraceCount >= 50 && !hasExistingProposal(key + "-") && !hasExistingProposal(deployedSkill + "-v") && !hasExistingProposal(deployedSkill + "-evolved")) {
          console.log(`[aceforge] ${key} has ${newTraceCount} new traces — triggering evolution`);
          const existingMdPath = path.join(SKILLS_DIR, deployedSkill, "SKILL.md");
          try {
            const existingMd = fsSync.readFileSync(existingMdPath, "utf-8");
            const newTraces = entries.filter(e => new Date(e.ts).getTime() > new Date(baseline.ts).getTime());
            const evoCand = {
              tool: key,
              args_summary_prefix: entries[0].args_summary?.slice(0, 50) || "",
              occurrences: entries.length,
              success_rate: Math.round(successRate * 100) / 100,
              distinct_sessions: sessions.size,
              first_seen: entries[entries.length - 1].ts,
              last_seen: entries[0].ts,
            };
            const revResult = await reviseSkillWithLLm(evoCand, existingMd, newTraces as any);
            if (revResult && revResult.verdict !== "REJECT") {
              const evoNameMatch = revResult.skillMd.match(/^name:\s*(.+)$/m);
              const evoName = evoNameMatch
                ? evoNameMatch[1].trim().replace(/[^a-z0-9-_]/gi, "-").toLowerCase().slice(0, 60)
                : deployedSkill + "-v2";
              writeProposal(evoName, revResult.skillMd);
              appendJsonl("candidates.jsonl", { ...evoCand, type: "evolution", replaces: deployedSkill });

              const descMatch = revResult.skillMd.match(/^description:\s*["']?(.+?)["']?$/m);
              const summary = descMatch ? descMatch[1].slice(0, 120) : "Evolved skill";

              notify(
                `🔄 ${bold("Evolution Proposal")}\n\n` +
                `${bold(evoName)}\n` +
                `Replaces ${deployedSkill} · ${newTraceCount} new traces\n\n` +
                `${mono("/forge approve " + evoName)}\n${mono("/forge reject " + evoName)}`
              ).catch(err => console.error("[aceforge] notify error:", err));
              evolutionProposed = true;
            }
          } catch (evoErr) {
            console.error(`[aceforge] evolution error: ${(evoErr as Error).message}`);
            logFilteredCandidate(key, "evolution_error", `Evolution generation failed: ${(evoErr as Error).message?.slice(0, 100) || "unknown"}`, { occurrences: entries.length });
          }
        }
      }

      // ═══ Path 2: Upgrade — deployed skill scoring below 60 ═══
      if (!evolutionProposed) {
        try {
          const existingPath = path.join(SKILLS_DIR, deployedSkill, "SKILL.md");
          const existingMd = fsSync.readFileSync(existingPath, "utf-8");
          const report = scoreSkill(existingMd, key);

          if (report.combined >= 60) {
            console.log(`[aceforge] ${deployedSkill} scores ${report.combined}/100 — adequate, skipping`);
            continue;
          }

          let finalScore = report.combined;
          let judgeReasoning = "";
          if (report.combined >= 40 && report.combined < 70) {
            const traceSamples = entries.slice(0, 10).map(e =>
              `[${e.success ? "OK" : "FAIL"}] ${e.args_summary || "(none)"} → ${(e as any).result_summary || (e as any).error || "(none)"}`
            ).join("\n");
            const judgeResult = await llmJudgeEvaluate(existingMd, key, report, traceSamples);
            if (judgeResult) {
              finalScore = Math.round(0.5 * report.combined + 0.5 * judgeResult.adjustedScore);
              judgeReasoning = judgeResult.reasoning;
              console.log(`[aceforge] LLM judge: ${judgeResult.adjustedScore}/100 (${judgeResult.recommendation}). Final: ${finalScore}`);
              if (finalScore >= 60) {
                console.log(`[aceforge] ${deployedSkill} passes after LLM judge — skipping`);
                continue;
              }
            }
          }

          console.log(`[aceforge] ${deployedSkill} scores ${finalScore}/100 — proposing upgrade`);

          const upgradeName = deployedSkill + "-upgrade";
          if (hasExistingProposal(upgradeName)) {
            console.log(`[aceforge] upgrade proposal already exists for ${deployedSkill}`);
            continue;
          }

          const candidate = {
            tool: key,
            args_summary_prefix: entries[0].args_summary?.slice(0, 50) || "",
            occurrences: entries.length,
            success_rate: Math.round(successRate * 100) / 100,
            distinct_sessions: sessions.size,
            first_seen: entries[entries.length - 1].ts,
            last_seen: entries[0].ts,
          };

          const { generateUpgradeSkillWithLLm } = await import("../skill/llm-generator.js");
          const upgradeResult = await generateUpgradeSkillWithLLm(candidate, existingMd, report);
          if (upgradeResult && upgradeResult.verdict !== "REJECT") {
            writeProposal(upgradeName, upgradeResult.skillMd);
            appendJsonl("candidates.jsonl", {
              ...candidate,
              type: "upgrade",
              replaces: deployedSkill,
              oldScore: report.combined,
            });

            const reportText = `${report.deficiencies.slice(0, 3).join("; ")}`;
            notify(
              `⬆️ ${bold("Upgrade Proposal")}\n\n` +
              `${bold(upgradeName)}\n` +
              `Replaces ${deployedSkill} · Score: ${finalScore}/100\n` +
              `Issues: ${reportText}\n` +
              (judgeReasoning ? `LLM judge: ${judgeReasoning.slice(0, 100)}\n` : "") +
              `Use: /forge upgrade ${deployedSkill}  or  /forge reject ${upgradeName}`
            ).catch(err => console.error("[aceforge] notify error:", err));
          }
        } catch (err) {
          console.error(`[aceforge] upgrade scoring error: ${(err as Error).message}`);
          logFilteredCandidate(key, "upgrade_error", `Upgrade scoring failed: ${(err as Error).message?.slice(0, 100) || "unknown"}`, { occurrences: entries.length });
        }
      }
      continue;
    }

    // ═══ Path 3: New skill proposal — no deployed skill exists ═══

    if (successRate < SUCCESS_RATE_MIN) {
      logFilteredCandidate(key, "low_success_rate", `${Math.round(successRate * 100)}% < ${Math.round(SUCCESS_RATE_MIN * 100)}% minimum`, { occurrences: entries.length, successRate: Math.round(successRate * 100) / 100 });
      continue;
    }

    // Require temporal spread — reject concentrated bursts, accept organic usage
    const distinctDays = new Set(entries.map(e => new Date(e.ts).toISOString().slice(0, 10))).size;
    const distinctHours = new Set(entries.map(e => new Date(e.ts).toISOString().slice(0, 13))).size;
    if (sessions.size < 2 && distinctDays < 2 && distinctHours < 2) {
      logFilteredCandidate(key, "temporal_burst", `${sessions.size} session(s), ${distinctDays} day(s), ${distinctHours} hour(s)`, { occurrences: entries.length, sessions: sessions.size, distinctDays, distinctHours });
      continue;
    }

    if (hasExistingProposal(key)) {
      logFilteredCandidate(key, "proposal_exists", "proposal already pending");
      continue;
    }

    // F1 fix: check if another proposal already covers this tool
    const existingProposal = hasProposalForSameTool(key);
    if (existingProposal) {
      logFilteredCandidate(key, "dedup_proposal", `covered by existing proposal '${existingProposal}'`);
      continue;
    }

    // Skip if ClawHub already has a skill for this tool
    try {
      const safeTool = key.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!safeTool) throw new Error("empty tool name after sanitization");
      const { execSync } = await import("child_process");
      const clawHubResult = execSync(
        `clawhub search "${safeTool}" --limit 3 --json 2>/dev/null || echo "[]"`,
        { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (clawHubResult && clawHubResult !== "[]") {
        try {
          const results = JSON.parse(clawHubResult);
          if (Array.isArray(results) && results.length > 0) {
            const exactMatch = results.find((r: any) =>
              r.name?.toLowerCase() === key.toLowerCase() ||
              r.slug?.toLowerCase() === key.toLowerCase()
            );
            if (exactMatch) {
              console.log(`[aceforge] skipping ${key} — ClawHub already has skill: ${exactMatch.slug || exactMatch.name}`);
              continue;
            }
          }
        } catch { /* JSON parse failed, continue */ }
      }
    } catch {
      // clawhub CLI not installed or timed out — skip check gracefully
    }

    const argsPrefix = entries[0].args_summary?.slice(0, 50) || "";
    const candidate = {
      ts: new Date().toISOString(),
      tool: key,
      args_summary_prefix: argsPrefix,
      occurrences: entries.length,
      success_rate: Math.round(successRate * 100) / 100,
      distinct_sessions: sessions.size,
      first_seen: entries[entries.length - 1].ts,
      last_seen: entries[0].ts,
    };

    // Guard against path traversal in skill names
    if (key.includes("..") || key.includes("/") || key.includes("\\")) {
      console.error(`[aceforge] rejected tool name with path characters: ${key}`);
      continue;
    }

    // Generate SKILL.md — try LLM first, fall back to template
    let skillName = "";
    let skillMd = "";
    let validationNotes: string[] = [];
    try {
      const llmResult = await generateSkillWithLLm(candidate);

      if (llmResult) {
        skillMd = llmResult.skillMd;
        const nameMatch = llmResult.skillMd.match(/^name:\s*(.+)$/m);
        skillName = nameMatch
          ? nameMatch[1].trim().replace(/[^a-z0-9-_]/gi, "-").toLowerCase().slice(0, 60)
          : key.replace(/[^a-z0-9-_]/gi, "_") + "-skill";

        if (llmResult.verdict === "REJECT") {
          console.warn(`[aceforge] LLM rejected ${key}: ${llmResult.feedback || ""}`);
          appendJsonl("candidates.jsonl", { ...candidate, llm_rejected: true, llm_feedback: llmResult.feedback });
          continue;
        }

        const validation = validateSkillMd(skillMd, skillName);
        if (!validation.valid) {
          console.error(`[aceforge] LLM skill validation FAILED: ${validation.errors.join("; ")}`);
        }
        validationNotes = [...(validation.errors || []), ...(validation.warnings || [])];

        if (skillName.includes("..") || skillName.includes("/") || skillName.includes("\\")) {
          console.error(`[aceforge] rejected skill name with path characters: ${skillName}`);
          continue;
        }
        writeProposal(skillName, skillMd);
        console.log(`[aceforge] LLM proposal written: ${skillName}`);
      } else {
        const result = generateSkillFromCandidate(candidate);
        skillName = result.skillName;
        skillMd = result.skillMd;

        const validation = validateSkillMd(skillMd, skillName);
        validationNotes = [...(validation.errors || []), ...(validation.warnings || [])];

        writeProposal(skillName, skillMd);
        console.log(`[aceforge] template proposal written: ${skillName}`);
      }
    } catch (err) {
      console.error(`[aceforge] proposal generation error for ${key}:`, err);
      logFilteredCandidate(key, "generation_error", `LLM generation failed: ${(err as Error).message?.slice(0, 100) || "unknown"}`, { occurrences: entries.length });
      continue;
    }

    appendJsonl("candidates.jsonl", candidate);
    newCandidates++;

    const descMatch = skillMd.match(/^description:\s*["']?(.+?)["']?$/m);
    const summary = descMatch ? descMatch[1].slice(0, 120) : "No description";

    const notesSuffix = validationNotes.length > 0
      ? `\nValidator: ${validationNotes.join("; ")}`
      : "";

    notify(
      `New Skill Proposal\n` +
      `${skillName}\n` +
      `Tool: ${key}\n` +
      `${entries.length}x, ${Math.round(successRate * 100)}% success, ${sessions.size} sessions\n` +
      `Summary: ${summary}` +
      notesSuffix + `\n` +
      `Use: /forge approve ${skillName}  or  /forge reject ${skillName}`
    ).catch(err => console.error("[aceforge] notify error:", err));
  }

  console.log(
    `[aceforge] pattern analysis complete — ${groups.size} groups evaluated, ` +
    `${newCandidates} new candidates`
  );

  // Chain-to-Workflow Analysis
  await analyzeChains(patterns).catch(err =>
    console.error(`[aceforge] chain analysis error: ${(err as Error).message}`)
  );

  // Gap Analysis
  await analyzeGaps(patterns).catch(err =>
    console.error(`[aceforge] gap analysis error: ${(err as Error).message}`)
  );

  // Effectiveness Watchdog
  try {
    const { runEffectivenessWatchdog } = await import("../skill/lifecycle.js");
    const watchdogAlerts = runEffectivenessWatchdog();
    if (watchdogAlerts.length > 0) {
      const alertText = watchdogAlerts.map((a: any) =>
        `${a.skill}: ${a.reason === "no_improvement"
          ? `no improvement after ${a.activations} activations (${Math.round(a.successRate * 100)}% vs ${Math.round(a.baselineRate * 100)}% baseline)`
          : `degraded to ${Math.round(a.successRate * 100)}% success over ${a.activations} activations`}`
      ).join("\n");
      console.warn(`[aceforge] watchdog alerts:\n${alertText}`);
      notify(
        `Skill Effectiveness Alert\n` +
        `${watchdogAlerts.length} skill(s) flagged for review:\n` +
        alertText + `\n` +
        `Consider: /forge retire <name> or wait for evolution cycle`
      ).catch(err => console.error("[aceforge] notify error:", err));
    }
  } catch (err) {
    console.error(`[aceforge] watchdog error: ${(err as Error).message}`);
  }

  // Flush digest if enabled — sends all queued notifications as one message
  await flushDigest();
}

// ─── Gap Analysis → Remediation Skill Proposals ─────────────────────────

async function analyzeGaps(preloadedPatterns?: PatternEntry[]): Promise<void> {
  const gaps = detectGaps(preloadedPatterns);
  if (gaps.length === 0) return;

  console.log(`[aceforge] gap analysis found ${gaps.length} capability gaps`);

  for (const gap of gaps.slice(0, 3)) {
    if (gap.severity < 6) continue;

    // H1 hotfix: skip remediation for native OpenClaw tools
    if (NATIVE_TOOLS.has(gap.tool)) {
      console.log(`[aceforge] skipping remediation for native tool: ${gap.tool}`);
      continue;
    }

    const skillName = gap.tool.replace(/[^a-z0-9-_]/gi, "-").toLowerCase() + "-guard";

    if (findDeployedSkill(skillName)) continue;
    if (hasExistingProposal(skillName)) continue;

    console.log(`[aceforge] gap candidate: ${gap.tool} (${gap.gapType}, severity=${gap.severity})`);

    try {
      const result = await generateRemediationSkillWithLLm(gap);
      if (!result || result.verdict === "REJECT") {
        console.log(`[aceforge] remediation skill rejected for ${gap.tool}`);
        continue;
      }

      const validation = validateSkillMd(result.skillMd, skillName);
      const validationNotes = [...(validation.errors || []), ...(validation.warnings || [])];

      writeProposal(skillName, result.skillMd);
      appendJsonl("candidates.jsonl", {
        ts: new Date().toISOString(),
        tool: gap.tool,
        type: "remediation",
        gapType: gap.gapType,
        severity: gap.severity,
      });

      const notesSuffix = validationNotes.length > 0
        ? `\nValidator: ${validationNotes.join("; ")}`
        : "";

      const severityLabel = gap.severity >= 12 ? "HIGH" : gap.severity >= 6 ? "MEDIUM" : "LOW";

      notify(
        `🛡️ ${bold("Remediation Proposal")}\n\n` +
        `${bold(skillName)}\n` +
        `${gap.tool} · ${severityLabel} · ${gap.gapType.replace(/_/g, " ")}\n` +
        `${gap.evidence.slice(0, 2).join("; ")}` +
        notesSuffix + `\n\n` +
        `${mono("/forge approve " + skillName)}\n${mono("/forge reject " + skillName)}`
      ).catch(err => console.error("[aceforge] notify error:", err));

      console.log(`[aceforge] remediation proposal written: ${skillName}`);
    } catch (err) {
      console.error(`[aceforge] remediation generation error for ${gap.tool}:`, err);
    }
  }
}
