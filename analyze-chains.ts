/**
 * Chain-to-Workflow Skill Proposals
 *
 * v0.8.1: Extracted from analyze.ts
 *
 * Detects multi-tool chains (3+ distinct tools within 60s) that recur
 * across sessions, and proposes workflow skills that teach the complete pipeline.
 *
 * Research: MACLA (arXiv:2512.18950) — composing atomic procedures into meta-procedures.
 */
import { appendJsonl } from "./store.js";
import { notify } from "../notify.js";
import { writeProposal } from "../skill/generator.js";
import { validateSkillMd } from "../skill/validator.js";
import { generateWorkflowSkillWithLLm } from "../skill/llm-generator.js";
import { type PatternEntry } from "./constants.js";
import {
  logFilteredCandidate,
  findDeployedSkill,
  hasExistingProposal,
} from "./analyze-utils.js";

// ─── Chain-to-Workflow Skill Proposals ──────────────────────────────────

export async function analyzeChains(patterns: PatternEntry[]): Promise<void> {
  const chains = patterns.filter(p => p.type === "chain" && Array.isArray(p.tools));
  if (chains.length < 3) return;

  const sequenceGroups = new Map<string, typeof chains>();
  for (const chain of chains) {
    const tools = chain.tools as string[];
    const key = tools.join("→");
    if (!sequenceGroups.has(key)) sequenceGroups.set(key, []);
    sequenceGroups.get(key)!.push(chain);
  }

  for (const [seqKey, entries] of sequenceGroups) {
    if (entries.length < 3) continue;

    const tools = seqKey.split("→");
    const sessions = new Set(entries.map(e => e.session).filter(Boolean));
    if (sessions.size < 2) continue;

    const skillName = tools
      .map(t => t.replace(/[^a-z0-9]/gi, "").slice(0, 10))
      .join("-") + "-workflow";

    if (findDeployedSkill(skillName)) continue;
    if (hasExistingProposal(skillName)) continue;

    // F4 fix: compositionality filter — skip workflow proposals when all
    // constituent tools individually have >80% success rate
    const toolSuccessRates: number[] = [];
    for (const t of tools) {
      const toolEntries = patterns.filter(p =>
        p.tool === t && p.type !== "correction" && p.type !== "chain"
      );
      if (toolEntries.length >= 3) {
        const successes = toolEntries.filter(e => e.success).length;
        toolSuccessRates.push(successes / toolEntries.length);
      }
    }
    if (toolSuccessRates.length === tools.length && toolSuccessRates.every(r => r > 0.8)) {
      logFilteredCandidate(seqKey, "compositionality", `all ${tools.length} tools individually >80% success — chain adds no value`, { toolSuccessRates: toolSuccessRates.map(r => Math.round(r * 100)) });
      continue;
    }

    console.log(`[aceforge] workflow candidate: ${seqKey} (${entries.length}x, ${sessions.size} sessions)`);

    // H6 fix: populate sampleTraces by correlating individual tool traces
    // to chain events within the same session and time window
    const sampleTraces: Array<{ tool: string; args_summary?: string; result_summary?: string; success: boolean; error?: string }[]> = [];
    for (const chainEntry of entries.slice(0, 3)) {
      const chainTime = new Date(chainEntry.ts).getTime();
      const chainSession = chainEntry.session;
      const stepsForThisExecution: { tool: string; args_summary?: string; result_summary?: string; success: boolean; error?: string }[] = [];
      for (const toolName of tools) {
        // Find the individual tool trace closest to the chain event in the same session
        const match = patterns
          .filter(p => p.tool === toolName && p.session === chainSession && p.type !== "chain" && p.type !== "correction")
          .filter(p => Math.abs(new Date(p.ts).getTime() - chainTime) < 120000)
          .sort((a, b) => Math.abs(new Date(a.ts).getTime() - chainTime) - Math.abs(new Date(b.ts).getTime() - chainTime))[0];
        if (match) {
          stepsForThisExecution.push({
            tool: match.tool,
            args_summary: (match.args_summary || "").slice(0, 100),
            result_summary: ((match.result_summary as string) || "").slice(0, 100),
            success: match.success,
            error: ((match.error as string) || "").slice(0, 80) || undefined,
          });
        }
      }
      if (stepsForThisExecution.length > 0) sampleTraces.push(stepsForThisExecution);
    }

    const chainCandidate = {
      toolSequence: tools,
      occurrences: entries.length,
      successRate: 1.0,
      distinctSessions: sessions.size,
      sampleTraces,
    };

    try {
      const result = await generateWorkflowSkillWithLLm(chainCandidate);
      if (!result || result.verdict === "REJECT") {
        console.log(`[aceforge] workflow skill rejected for ${seqKey}`);
        continue;
      }

      const validation = validateSkillMd(result.skillMd, skillName);
      const validationNotes = [...(validation.errors || []), ...(validation.warnings || [])];

      writeProposal(skillName, result.skillMd);
      appendJsonl("candidates.jsonl", {
        ts: new Date().toISOString(),
        tool: seqKey,
        type: "workflow",
        occurrences: entries.length,
        distinct_sessions: sessions.size,
      });

      const notesSuffix = validationNotes.length > 0
        ? `\nValidator: ${validationNotes.join("; ")}`
        : "";

      notify(
        `Workflow Skill Proposal\n` +
        `${skillName}\n` +
        `Pipeline: ${tools.join(" → ")}\n` +
        `${entries.length}x across ${sessions.size} sessions` +
        notesSuffix + `\n` +
        `Use: /forge approve ${skillName}  or  /forge reject ${skillName}`
      ).catch(err => console.error("[aceforge] notify error:", err));

      console.log(`[aceforge] workflow proposal written: ${skillName}`);
    } catch (err) {
      console.error(`[aceforge] workflow generation error for ${seqKey}:`, err);
    }
  }
}
