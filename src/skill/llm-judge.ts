/**
 * LLM-as-Judge — AceForge v0.6.0
 *
 * Invoked ONLY for skills scoring 40-70 (ambiguous zone).
 * Uses the reviewer LLM to semantically evaluate skill quality
 * against actual trace data.
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import type { QualityReport } from "./quality-score.js";
import { loadLlmConfig } from "./llm-generator.js";

// ─── H8-fix: Use os.homedir() instead of process.env.HOME || "~"
const HOME = os.homedir() || process.env.HOME || "";

// ─── G5: Rate limiter (same as llm-generator.ts — prevents judge API spam) ──
const JUDGE_MIN_INTERVAL_MS = 2000;
const JUDGE_MAX_CALLS_PER_CYCLE = 8;
const JUDGE_TIMEOUT_MS = 30_000; // 30s timeout
let _judgeLastCallMs = 0;
let _judgeCallsThisCycle = 0;

export function resetJudgeRateLimit(): void { _judgeCallsThisCycle = 0; }

async function rateLimitedFetch(url: string, init: RequestInit): Promise<Response> {
  if (_judgeCallsThisCycle >= JUDGE_MAX_CALLS_PER_CYCLE) {
    console.warn("[aceforge/judge] Rate limit reached — skipping");
    throw new Error("Rate limit: max judge calls per cycle reached");
  }
  const now = Date.now();
  const wait = Math.max(0, JUDGE_MIN_INTERVAL_MS - (now - _judgeLastCallMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _judgeLastCallMs = Date.now();

  // Bug #3: timeout prevents pipeline stall; Bug #8: count after dispatch
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  _judgeCallsThisCycle++;
  return res;
}

// loadLlmConfig imported from llm-generator.ts — single source of truth.
// PROVIDER_DEFAULTS are embedded in loadLlmConfig; judge uses config output only.



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
  const config = loadLlmConfig();
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
    const endpoint = config.reviewerApiFormat === "anthropic" ? `${config.reviewerUrl}/v1/messages` : `${config.reviewerUrl}/chat/completions`;
    const headers = config.reviewerApiFormat === "anthropic"
      ? { "Content-Type": "application/json", "x-api-key": config.reviewerKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", "Authorization": `Bearer ${config.reviewerKey}` };
    const res = await rateLimitedFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(config.reviewerApiFormat === "anthropic" ? {
        model: config.reviewerModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
      } : {
        model: config.reviewerModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
      }),
    });

    if (!res.ok) {
      console.error(`[aceforge/judge] LLM API ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = config.reviewerApiFormat === "anthropic"
      ? (data.content?.find((b: any) => b.type === "text")?.text || "")
      : (data.choices?.[0]?.message?.content || "");

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
