/**
 * LLM-as-Judge — AceForge v0.6.0
 *
 * Invoked ONLY for skills scoring 40-70 (ambiguous zone).
 * Uses the reviewer LLM to semantically evaluate skill quality
 * against actual trace data.
 */
import * as fsSync from "fs";
import * as path from "path";
import type { QualityReport } from "./quality-score.js";

interface LlmConfig {
  reviewerKey: string;
  reviewerUrl: string;
  reviewerModel: string;
}

const PROVIDER_DEFAULTS: Record<string, { url: string; model: string }> = {
  deepseek:   { url: "https://api.deepseek.com",     model: "deepseek-reasoner" },
  openai:     { url: "https://api.openai.com/v1",    model: "gpt-4o" },
  minimax:    { url: "https://api.minimax.io/v1",    model: "MiniMax-M2.7" },
  openrouter: { url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4" },
};

function loadConfig(): LlmConfig {
  const cfgPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fsSync.readFileSync(cfgPath, "utf-8")); } catch {}

  const providers = (cfg as any)?.models?.providers as Record<string, Record<string, string>> | undefined;
  const revProvider = process.env.ACEFORGE_REVIEWER_PROVIDER || "deepseek";
  const revCfg = providers?.[revProvider] || {};
  const revDef = PROVIDER_DEFAULTS[revProvider] || { url: "", model: "" };

  return {
    reviewerKey: revCfg.apiKey || process.env.ACEFORGE_REVIEWER_API_KEY || "",
    reviewerUrl: (revCfg.baseURL || process.env.ACEFORGE_REVIEWER_URL || revDef.url).replace(/\/$/, ""),
    reviewerModel: process.env.ACEFORGE_REVIEWER_MODEL || revDef.model,
  };
}

export interface JudgeResult {
  adjustedScore: number;
  reasoning: string;
  recommendation: "upgrade" | "keep" | "borderline";
}

export async function llmJudgeEvaluate(
  skillMd: string,
  toolName: string,
  deterministicReport: QualityReport,
  traceSamples: string
): Promise<JudgeResult | null> {
  const config = loadConfig();
  if (!config.reviewerKey) {
    console.log("[aceforge/judge] No reviewer API key — skipping LLM judge");
    return null;
  }

  const prompt = `You are evaluating the quality of a SKILL.md file for an OpenClaw AI agent.
The skill has been scored by a deterministic quality system. You are reviewing the borderline cases (score 40-70) to determine if this skill should be upgraded with a better version.

## Deterministic Scores
Structural: ${deterministicReport.structural}/100
Coverage: ${deterministicReport.coverage}/100
Combined: ${deterministicReport.combined}/100

## Identified Deficiencies
${deterministicReport.deficiencies.length > 0 ? deterministicReport.deficiencies.map(d => "- " + d).join("\n") : "None identified"}

## Identified Strengths
${deterministicReport.strengths.length > 0 ? deterministicReport.strengths.map(s => "- " + s).join("\n") : "None identified"}

## The SKILL.md Being Evaluated
${skillMd.slice(0, 3000)}

## Actual Agent Usage Data (trace samples for tool: ${toolName})
${traceSamples.slice(0, 2000)}

## Your Task
Evaluate whether this skill adequately serves the agent's actual usage patterns. Consider:
1. Does the skill teach HOW to accomplish what the traces show the agent actually does?
2. Are the anti-patterns addressing real failures from the traces, or are they generic?
3. Does the description accurately trigger on the use cases shown in the traces?
4. Would this skill make the agent MORE reliable, or could it mislead?

Respond in EXACTLY this format:
SCORE: <number 0-100>
RECOMMENDATION: <upgrade|keep|borderline>
REASONING: <2-3 sentences explaining your assessment>`;

  try {
    const res = await fetch(`${config.reviewerUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.reviewerKey}`,
      },
      body: JSON.stringify({
        model: config.reviewerModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 500,
      }),
    });

    if (!res.ok) {
      console.error(`[aceforge/judge] LLM API ${res.status}`);
      return null;
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || "";

    const scoreMatch = content.match(/SCORE:\s*(\d+)/);
    const recMatch = content.match(/RECOMMENDATION:\s*(upgrade|keep|borderline)/i);
    const reasonMatch = content.match(/REASONING:\s*(.+)/s);

    if (!scoreMatch) return null;

    return {
      adjustedScore: parseInt(scoreMatch[1], 10),
      recommendation: (recMatch?.[1]?.toLowerCase() as "upgrade" | "keep" | "borderline") || "borderline",
      reasoning: reasonMatch?.[1]?.trim().slice(0, 300) || "No reasoning provided",
    };
  } catch (err) {
    console.error(`[aceforge/judge] LLM judge failed: ${(err as Error).message}`);
    return null;
  }
}
