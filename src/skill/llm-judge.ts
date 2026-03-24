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

// ─── H8-fix: Use os.homedir() instead of process.env.HOME || "~"
const HOME = os.homedir() || process.env.HOME || "";

// ─── G5: Rate limiter (same as llm-generator.ts — prevents judge API spam) ──
const JUDGE_MIN_INTERVAL_MS = 2000;
const JUDGE_MAX_CALLS_PER_CYCLE = 8;
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
  _judgeCallsThisCycle++;
  return fetch(url, init);
}

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

// ─── Config cache (avoids reading openclaw.json on every call) ──
let _configCache: { config: LlmConfig; ts: number } | null = null;
const CONFIG_CACHE_TTL_MS = 60_000; // 60 seconds

function loadConfig(): LlmConfig {
  // Return cached config if still fresh
  if (_configCache && Date.now() - _configCache.ts < CONFIG_CACHE_TTL_MS) {
    return _configCache.config;
  }
  const cfgPath = path.join(HOME, ".openclaw", "openclaw.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fsSync.readFileSync(cfgPath, "utf-8")); } catch {}

  const providers = (cfg as any)?.models?.providers as Record<string, Record<string, string>> | undefined;
  const revProvider = process.env.ACEFORGE_REVIEWER_PROVIDER || "deepseek";
  const revCfg = providers?.[revProvider] || {};
  const revDef = PROVIDER_DEFAULTS[revProvider] || { url: "", model: "" };

  const result: LlmConfig = {
    reviewerKey: revCfg.apiKey || process.env.ACEFORGE_REVIEWER_API_KEY || "",
    reviewerUrl: (revCfg.baseURL || process.env.ACEFORGE_REVIEWER_URL || revDef.url).replace(/\/$/, ""),
    reviewerModel: process.env.ACEFORGE_REVIEWER_MODEL || revDef.model,
  };

  _configCache = { config: result, ts: Date.now() };
  return result;
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
    const res = await rateLimitedFetch(`${config.reviewerUrl}/chat/completions`, {
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
