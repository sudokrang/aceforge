/**
 * LLM-powered Skill Generator — AceForge v0.6.0
 *
 * Dual-model pipeline:
 * 1. Generator (default: MiniMax M2.7) creates SKILL.md from pattern data
 * 2. Reviewer (default: DeepSeek Reasoner) reviews with Chain of Thought
 * 3. APPROVE → validator → notify; REVISE → retry once; REJECT → skip
 *
 * v0.6.0 fix: G2 — rate limiting prevents API spam during batch analysis
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { extractDomainPrefix } from "../pattern/analyze.js";

const HOME = os.homedir() || process.env.HOME || "";

const FORGE_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  ".forge"
);

// ─── G2: Rate limiter ───────────────────────────────────────────
const MIN_INTERVAL_MS = 2000;
const MAX_CALLS_PER_CYCLE = 8;
const LLM_TIMEOUT_MS = 30_000; // 30s — prevents pipeline stall on hung API
let lastLlmCallMs = 0;
let callsThisCycle = 0;

export function resetLlmRateLimit(): void {
  callsThisCycle = 0;
}

async function rateLimitedFetch(url: string, init: RequestInit): Promise<Response> {
  if (callsThisCycle >= MAX_CALLS_PER_CYCLE) {
    console.warn("[aceforge/llm] Rate limit reached for this cycle — skipping");
    throw new Error("Rate limit: max LLM calls per cycle reached");
  }
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastLlmCallMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastLlmCallMs = Date.now();

  // Bug #3: Add timeout to prevent pipeline stall on hung API
  // Bug #8: Only count successful dispatches against rate limit
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  callsThisCycle++; // count AFTER successful dispatch, not before
  return res;
}

// ─── Types ──────────────────────────────────────────────────────

interface Candidate {
  tool: string;
  args_summary_prefix: string;
  occurrences: number;
  success_rate: number;
  distinct_sessions: number;
  first_seen: string;
  last_seen: string;
  domainFilter?: string;  // When set, only collect traces matching this domain
}

interface TraceEntry {
  ts: string; tool: string; args_summary: string | null;
  result_summary: string | null; success: boolean;
  error: string | null; type?: string; text_fragment?: string;
}

interface LlmConfig {
  generatorKey: string; generatorUrl: string; generatorModel: string; generatorProvider: string;
  reviewerKey: string; reviewerUrl: string; reviewerModel: string; reviewerProvider: string;
}

interface GenerationResult {
  skillMd: string;
  verdict: "APPROVE" | "REVISE" | "REJECT";
  feedback?: string;
  usedLlm: boolean;
}

// ─── Provider defaults ──────────────────────────────────────────

const PROVIDER_DEFAULTS: Record<string, { url: string; model: string }> = {
  minimax:    { url: "https://api.minimax.io/v1",    model: "MiniMax-M2.7" },
  deepseek:   { url: "https://api.deepseek.com",     model: "deepseek-chat" },
  openai:     { url: "https://api.openai.com/v1",    model: "gpt-4o" },
  openrouter: { url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4" },
};

// ─── Config cache (avoids reading openclaw.json on every call) ──
let _configCache: { config: LlmConfig; ts: number } | null = null;
const CONFIG_CACHE_TTL_MS = 60_000; // 60 seconds

export function loadLlmConfig(): LlmConfig {
  // Return cached config if still fresh
  if (_configCache && Date.now() - _configCache.ts < CONFIG_CACHE_TTL_MS) {
    return _configCache.config;
  }

  const cfgPath = path.join(HOME, ".openclaw", "openclaw.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fsSync.readFileSync(cfgPath, "utf-8")); } catch {}

  const providers = (cfg as any)?.models?.providers as Record<string, Record<string, string>> | undefined;

  const genProvider = process.env.ACEFORGE_GENERATOR_PROVIDER || "minimax";
  const genCfg = providers?.[genProvider] || {};
  const genDef = PROVIDER_DEFAULTS[genProvider] || { url: "", model: "" };

  const revProvider = process.env.ACEFORGE_REVIEWER_PROVIDER || "deepseek";
  const revCfg = providers?.[revProvider] || {};
  const revDef = PROVIDER_DEFAULTS[revProvider] || { url: "", model: "" };

  const result: LlmConfig = {
    generatorKey: genCfg.apiKey || process.env.ACEFORGE_GENERATOR_API_KEY || "",
    generatorUrl: (genCfg.baseURL || process.env.ACEFORGE_GENERATOR_URL || genDef.url).replace(/\/$/, ""),
    generatorModel: process.env.ACEFORGE_GENERATOR_MODEL || genDef.model,
    generatorProvider: genProvider,
    reviewerKey: revCfg.apiKey || process.env.ACEFORGE_REVIEWER_API_KEY || "",
    reviewerUrl: (revCfg.baseURL || process.env.ACEFORGE_REVIEWER_URL || revDef.url).replace(/\/$/, ""),
    reviewerModel: process.env.ACEFORGE_REVIEWER_MODEL || revDef.model,
    reviewerProvider: revProvider,
  };

  _configCache = { config: result, ts: Date.now() };
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────

// M9 fix: sanitize trace data before injecting into LLM prompts
function sanitizeTraceField(value: string | null | undefined, maxLen: number = 100): string {
  if (!value) return "(none)";
  return value
    .replace(/[\x00-\x1f]/g, "")  // strip control characters
    .replace(/```/g, "\`\`\`")    // escape fence boundaries
    .slice(0, maxLen);
}



// ─── Doc Enrichment (v0.8.0) ────────────────────────────────────
// Pre-generation context from OpenViking docs and/or docs.openclaw.ai
// Research: Foundry's doc research during generation identified as a gap
// in competitive analysis. This bridges trace-only generation with docs.

async function fetchDocEnrichment(toolName: string): Promise<string> {
  let context = "";

  // Source 1: OpenViking with docs-scoped target_uri
  try {
    const { searchViking } = await import("../viking/client.js");
    const result = await searchViking(
      `${toolName} usage documentation API reference configuration`,
      "viking://docs/"
    );
    if (result) {
      const text = typeof result === "string" ? result :
        Array.isArray(result) ? (result as any[]).map((r: any) => r.text || r.content || "").filter(Boolean).join("\n") :
        JSON.stringify(result);
      if (text.length > 20) context = text.slice(0, 600);
    }
  } catch { /* Viking unavailable */ }

  // Source 2: docs.openclaw.ai (optional, env-configurable)
  if (!context) {
    const docsUrl = process.env.ACEFORGE_DOCS_URL;
    if (docsUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${docsUrl}/api/search?q=${encodeURIComponent(toolName)}&limit=3`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json() as { results?: Array<{ content?: string }> };
          if (data.results && data.results.length > 0) {
            context = data.results.map((r: any) => r.content || "").join("\n").slice(0, 600);
          }
        }
      } catch { /* docs.openclaw.ai unavailable */ }
    }
  }

  return context;
}

function inferCategory(toolName: string): string {
  const tool = toolName.toLowerCase();
  if (["exec", "exec-ssh", "scp", "rsync"].includes(tool)) return "operations";
  if (["web-fetch", "web_fetch", "web_search", "browser"].includes(tool)) return "monitoring";
  if (["read", "pdf", "image", "memory_search", "memory_recall"].includes(tool)) return "analysis";
  if (["write", "edit", "delete", "move", "copy"].includes(tool)) return "development";
  if (["message", "session_send", "broadcast"].includes(tool)) return "communication";
  return "general";
}

function collectTracesForCandidate(candidate: Candidate): { traces: TraceEntry[]; corrections: TraceEntry[] } {
  const patternsFile = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(patternsFile)) return { traces: [], corrections: [] };
  const content = fsSync.readFileSync(patternsFile, "utf-8");
  if (!content.trim()) return { traces: [], corrections: [] };

  const traces: TraceEntry[] = [];
  const corrections: TraceEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TraceEntry;
      if (e.tool === candidate.tool && e.type !== "correction") {
        // Domain filtering: when domainFilter is set (native tool sub-patterns),
        // only include traces whose args match the target domain.
        // This prevents exec-openclaw from seeing docker/git/ssh traces.
        if (candidate.domainFilter) {
          const domain = extractDomainPrefix(e.tool, e.args_summary);
          if (domain !== candidate.domainFilter) continue;
        }
        traces.push(e);
      }
      // C1 fix: corrections don't have a tool field — match by temporal proximity
      // to this candidate's tool calls within the same session
      if (e.type === "correction" && e.text_fragment) corrections.push(e);
    } catch {}
  }

  // C1 fix: filter corrections to those within 2 min of a tool trace for this candidate
  const toolTimestamps = traces.map(t => new Date(t.ts).getTime());
  const nearCorrections = corrections.filter(c => {
    const corrTime = new Date(c.ts).getTime();
    return toolTimestamps.some(t => Math.abs(corrTime - t) < 120000);
  });

  return { traces, corrections: nearCorrections };
}

function buildSkillBrief(candidate: Candidate, traces: TraceEntry[], corrections: TraceEntry[], docContext?: string): string {
  const successTraces = traces.filter(t => t.success);
  const failureTraces = traces.filter(t => !t.success);

  const successSamples = successTraces.slice(0, 5).map(t =>
    `  - Args: ${sanitizeTraceField(t.args_summary)}\n    Result: ${sanitizeTraceField(t.result_summary, 150)}`
  ).join("\n");
  const failureSamples = failureTraces.slice(0, 3).map(t =>
    `  - Args: ${sanitizeTraceField(t.args_summary)}\n    Error: ${sanitizeTraceField(t.error, 80)}`
  ).join("\n");
  const correctionSamples = corrections.slice(0, 5).map(c =>
    `  - "${c.text_fragment || c.args_summary || ""}"`
  ).join("\n");

  return `You are writing a SKILL.md file for an OpenClaw AI agent. This skill will be permanently loaded into the agent's system prompt and used on future tasks matching this pattern.

## Pattern Data
Tool: ${candidate.tool}
Category: ${inferCategory(candidate.tool)}
Occurrences: ${candidate.occurrences} across ${candidate.distinct_sessions} sessions
Success rate: ${Math.round(candidate.success_rate * 100)}%

## Successful Execution Samples
${successSamples || "None"}

## Failure Samples (USE THESE to write a strong Anti-Patterns section)
${failureSamples || "None"}

## Corrections from User
${correctionSamples || "None"}

## Requirements
- Write a complete SKILL.md with YAML frontmatter (name, description, metadata.openclaw.category)
- The description field must be a trigger phrase matching how the user naturally requests this task
- Instructions must teach HOW to accomplish the task — not just which tool to call
- Focus the skill on the 2-3 most common usage patterns from the samples
- Structure: When to Use → Pre-flight Checks → Instructions → Error Recovery → Anti-Patterns
- Include an Anti-Patterns section based on any failures or corrections
- Keep under 150 lines
- Do NOT include credentials, API keys, or tokens

## Reference Documentation (from operational context)
\${docContext ? docContext : "No documentation context available — generate from trace data only."}

Output ONLY the raw SKILL.md content. No markdown fences, no preamble.`;
}

function buildReviewPrompt(generatedMd: string): string {
  return `Review this SKILL.md generated for an OpenClaw AI agent. Evaluate critically:
1. Does it teach genuine expertise or just echo tool names back?
2. Are instructions specific enough to improve task execution?
3. Could the description trigger false matches on unrelated tasks?
4. Any security concerns (injection patterns, credential leaks, path traversal)?
5. Is the Anti-Patterns section grounded in real failure data?
6. TRIGGER PHRASE CHECK: The description field MUST read as a natural trigger phrase — how a user would request this task. If it reads as an imperative rule ("Before doing X, always Y") or a behavioral instruction ("When X fails, do Y"), respond REVISE with feedback to rewrite as a natural request phrase (e.g., "Execute remote commands via SSH on production servers").

Respond with EXACTLY one of:
- APPROVE: <one-line reason>
- REVISE: <specific feedback for improvement>
- REJECT: <reason>

SKILL.md:
${generatedMd}`;
}

// ─── API callers (rate-limited) ─────────────────────────────────

async function callGenerator(url: string, apiKey: string, model: string, brief: string): Promise<string> {
  const res = await rateLimitedFetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are an expert at writing OpenClaw SKILL.md files. You produce concise, actionable skill documents." },
        { role: "user", content: brief }
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Generator API ${res.status}: ${errText.slice(0, 200)}`);
  }
  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = await res.json();
  } catch (parseErr) {
    const preview = await res.text().catch(() => "(unreadable)");
    throw new Error(`Generator returned malformed JSON: ${preview.slice(0, 100)}`);
  }
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Generator returned empty response");
  // Strip CoT reasoning blocks (DeepSeek Reasoner, other CoT models)
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return content;
}

async function callReviewer(url: string, apiKey: string, model: string, reviewPrompt: string): Promise<{ verdict: string; reasoning?: string }> {
  const res = await rateLimitedFetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: reviewPrompt }],
      stream: false,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Reviewer API ${res.status}: ${errText.slice(0, 200)}`);
  }
  let data: { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  try {
    data = await res.json();
  } catch (parseErr) {
    const preview = await res.text().catch(() => "(unreadable)");
    throw new Error(`Reviewer returned malformed JSON: ${preview.slice(0, 100)}`);
  }
  const msg = data.choices?.[0]?.message;
  if (!msg?.content) throw new Error("Reviewer returned empty response");
  if (msg.reasoning_content) {
    console.log(`[aceforge/review] Reviewer CoT: ${msg.reasoning_content.slice(0, 100)}...`);
  }
  return { verdict: msg.content!, reasoning: msg.reasoning_content };
}

// ─── Frontmatter fixer ──────────────────────────────────────────

function fixFrontmatterNesting(md: string): string {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return md;
  const fm = fmMatch[1];
  const body = md.slice(fmMatch[0].length);

  const flatCategoryMatch = fm.match(/^category:\s*(.+)$/m);
  if (!flatCategoryMatch) return md;
  const categoryValue = flatCategoryMatch[1].trim();

  if (fm.includes("metadata:") && fm.includes("openclaw:") && /^\s+category:/m.test(fm)) {
    const cleaned = fm.replace(/^category:\s*.+\n?/m, "");
    return "---\n" + cleaned + "\n---" + body;
  }

  let cleaned = fm.replace(/^category:\s*.+\n?/m, "");

  if (cleaned.includes("metadata:") && cleaned.includes("openclaw:")) {
    cleaned = cleaned.replace(/(metadata:\s*\n\s+openclaw:)/, "$1\n      category: " + categoryValue);
  } else if (cleaned.includes("metadata:")) {
    cleaned = cleaned.replace(/(metadata:)/, "$1\n    openclaw:\n      category: " + categoryValue);
  } else {
    cleaned = cleaned.trimEnd() + "\nmetadata:\n  openclaw:\n    category: " + categoryValue;
  }

  return "---\n" + cleaned + "\n---" + body;
}

// ─── Main generation functions ──────────────────────────────────

export async function generateSkillWithLLm(candidate: Candidate): Promise<GenerationResult | null> {
  const config = loadLlmConfig();
  if (!config.generatorKey) {
    console.warn("[aceforge/llm-gen] Generator API key not configured — using fallback template");
    return null;
  }

  const { traces, corrections } = collectTracesForCandidate(candidate);

  // Doc enrichment: fetch relevant documentation before generation
  let docContext = "";
  try {
    docContext = await fetchDocEnrichment(candidate.tool);
    if (docContext) console.log(`[aceforge/llm-gen] Doc enrichment: ${docContext.length} chars for ${candidate.tool}`);
  } catch (enrichErr) {
    console.warn(`[aceforge/llm-gen] Doc enrichment failed for ${candidate.tool}: ${(enrichErr as Error).message?.slice(0, 80) || "unknown"}`);
  }

  const brief = buildSkillBrief(candidate, traces, corrections, docContext);

  let generatedMd: string;
  try {
    generatedMd = await callGenerator(config.generatorUrl, config.generatorKey, config.generatorModel, brief);
    console.log(`[aceforge/llm-gen] Generator produced ${generatedMd.length} chars`);
    if (generatedMd.length > 50000) {
      console.error("[aceforge/llm-gen] LLM output exceeds 50KB safety limit");
      return null;
    }
  } catch (err) {
    console.error(`[aceforge/llm-gen] Generator failed: ${(err as Error).message} — falling back to template`);
    return null;
  }

  let verdict = "APPROVE";
  let feedback: string | undefined;

  if (config.reviewerKey) {
    try {
      const reviewPrompt = buildReviewPrompt(generatedMd);
      const review = await callReviewer(config.reviewerUrl, config.reviewerKey, config.reviewerModel, reviewPrompt);
      const firstLine = review.verdict.trim().split("\n")[0].toUpperCase();
      if (firstLine.startsWith("APPROVE")) verdict = "APPROVE";
      else if (firstLine.startsWith("REVISE")) { verdict = "REVISE"; feedback = review.verdict.trim().slice(firstLine.length).trim(); }
      else if (firstLine.startsWith("REJECT")) { verdict = "REJECT"; feedback = review.verdict.trim().slice(firstLine.length).trim(); }
      console.log(`[aceforge/llm-gen] Reviewer verdict: ${verdict}`);
    } catch (err) {
      console.error(`[aceforge/llm-gen] Reviewer failed: ${(err as Error).message} — auto-approving`);
      verdict = "APPROVE";
    }
  }

  if (verdict === "REVISE" && feedback) {
    try {
      const retryPrompt = `${brief}\n\n---\n\nPrevious generation was rated REVISE:\n\n${feedback}\n\nRegenerate the SKILL.md addressing this feedback. Output ONLY the raw SKILL.md content. No markdown fences.`;
      generatedMd = await callGenerator(config.generatorUrl, config.generatorKey, config.generatorModel, retryPrompt);
      console.log(`[aceforge/llm-gen] Retry generated ${generatedMd.length} chars`);

      try {
        const retryReviewPrompt = buildReviewPrompt(generatedMd);
        const retryReview = await callReviewer(config.reviewerUrl, config.reviewerKey, config.reviewerModel, retryReviewPrompt);
        const retryLine = retryReview.verdict.trim().split("\n")[0].toUpperCase();
        if (retryLine.startsWith("APPROVE")) { verdict = "APPROVE"; }
        else if (retryLine.startsWith("REJECT")) { verdict = "REJECT"; feedback = retryReview.verdict.trim(); }
        else { verdict = "APPROVE"; console.warn("[aceforge/llm-gen] Retry still REVISE — accepting with warning"); }
      } catch (reviewErr) {
        console.error(`[aceforge/llm-gen] Retry review failed: ${(reviewErr as Error).message} — auto-approving`);
        verdict = "APPROVE";
      }
    } catch (err) {
      console.error(`[aceforge/llm-gen] Retry failed: ${(err as Error).message} — REJECTing`);
      verdict = "REJECT";
      feedback = `Retry generation also failed: ${(err as Error).message}`;
    }
  }

  return { skillMd: fixFrontmatterNesting(generatedMd), verdict: verdict as any, feedback, usedLlm: true };
}

export async function reviseSkillWithLLm(
  candidate: Candidate,
  existingSkillMd: string,
  newTraces: TraceEntry[]
): Promise<GenerationResult | null> {
  const config = loadLlmConfig();
  if (!config.generatorKey) return null;

  const { corrections } = collectTracesForCandidate(candidate);
  const successSamples = newTraces.filter(t => t.success).slice(0, 5).map(t =>
    `  - Args: ${sanitizeTraceField(t.args_summary)}\n    Result: ${sanitizeTraceField(t.result_summary, 150)}`).join("\n");
  const failureSamples = newTraces.filter(t => !t.success).slice(0, 5).map(t =>
    `  - Args: ${sanitizeTraceField(t.args_summary)}\n    Error: ${sanitizeTraceField(t.error, 80)}`).join("\n");
  const correctionSamples = corrections.slice(0, 5).map(c =>
    `  - "${c.text_fragment || c.args_summary || ""}"`).join("\n");

  const revisionBrief = `You are revising an existing SKILL.md for an OpenClaw AI agent. The skill has been deployed and used in production. New usage data has been collected since deployment.

## Existing Skill (DO NOT rewrite from scratch — improve it)
${existingSkillMd}

## New Data Since Deployment (${newTraces.length} new traces)
### New Successful Patterns
${successSamples || "None"}
### New Failure Patterns
${failureSamples || "None"}
### New User Corrections
${correctionSamples || "None"}

## Revision Instructions
- Keep everything that works well in the existing skill
- Add new patterns, edge cases, or anti-patterns from the new data
- Remove or update any instructions that the new failure data contradicts
- Keep under 200 lines
- Do NOT include credentials, API keys, or tokens

Output ONLY the complete revised SKILL.md content. No markdown fences, no preamble.`;

  let generatedMd: string;
  try {
    generatedMd = await callGenerator(config.generatorUrl, config.generatorKey, config.generatorModel, revisionBrief);
    console.log(`[aceforge/llm-gen] Revision generated ${generatedMd.length} chars`);
  } catch (err) {
    console.error(`[aceforge/llm-gen] Revision failed: ${(err as Error).message}`);
    return null;
  }

  let verdict = "APPROVE";
  let feedback: string | undefined;
  if (config.reviewerKey) {
    try {
      const review = await callReviewer(config.reviewerUrl, config.reviewerKey, config.reviewerModel, buildReviewPrompt(generatedMd));
      const firstLine = review.verdict.trim().split("\n")[0].toUpperCase();
      if (firstLine.startsWith("REJECT")) { verdict = "REJECT"; feedback = review.verdict.trim(); }
      else { verdict = "APPROVE"; }
    } catch (err) {
      console.error(`[aceforge/llm-gen] Revision review failed: ${(err as Error).message}`);
      verdict = "APPROVE";
    }
  }

  return { skillMd: fixFrontmatterNesting(generatedMd), verdict: verdict as any, feedback, usedLlm: true };
}

// ─── Workflow skill generation ──────────────────────────────────

interface ChainCandidate {
  toolSequence: string[]; occurrences: number; successRate: number; distinctSessions: number;
  sampleTraces: Array<{ tool: string; args_summary?: string; result_summary?: string; success: boolean; error?: string }[]>;
}

export async function generateWorkflowSkillWithLLm(chain: ChainCandidate): Promise<GenerationResult | null> {
  const config = loadLlmConfig();
  if (!config.generatorKey) return null;

  const stepsDesc = chain.toolSequence.map((t, i) => `Step ${i + 1}: ${t}`).join("\n");

  // H6 fix: include sample execution traces for operational context
  let sampleSection = "";
  if (chain.sampleTraces && chain.sampleTraces.length > 0) {
    sampleSection = "\n## Pipeline Execution Samples\n";
    for (let i = 0; i < Math.min(chain.sampleTraces.length, 3); i++) {
      sampleSection += `### Execution ${i + 1}\n`;
      for (const step of chain.sampleTraces[i]) {
        const status = step.success ? "OK" : "FAIL";
        sampleSection += `  ${step.tool} [${status}]: Args: ${step.args_summary || "(none)"} → ${step.success ? (step.result_summary || "ok") : (step.error || "failed")}\n`;
      }
    }
  }

  const brief = `You are writing a WORKFLOW SKILL for an OpenClaw AI agent. This skill teaches a multi-step pipeline.

## Workflow Pattern
Tools (in order): ${chain.toolSequence.join(" → ")}
Occurrences: ${chain.occurrences} across ${chain.distinctSessions} sessions

## Pipeline Steps
${stepsDesc}
${sampleSection}
## Requirements
- Write a WORKFLOW skill covering the COMPLETE pipeline
- Specify how output from each step feeds into the next
- Include error handling per step
- Category must be: workflow
- Keep under 150 lines
${sampleSection ? "- Use the execution samples above to write SPECIFIC instructions, not generic ones" : ""}
Output ONLY the raw SKILL.md content. No markdown fences, no preamble.`;

  let generatedMd: string;
  try {
    generatedMd = await callGenerator(config.generatorUrl, config.generatorKey, config.generatorModel, brief);
  } catch (err) {
    console.error(`[aceforge/llm-gen] Workflow generation failed: ${(err as Error).message}`);
    return null;
  }

  let verdict = "APPROVE";
  let feedback: string | undefined;
  if (config.reviewerKey) {
    try {
      const review = await callReviewer(config.reviewerUrl, config.reviewerKey, config.reviewerModel, buildReviewPrompt(generatedMd));
      const firstLine = review.verdict.trim().split("\n")[0].toUpperCase();
      if (firstLine.startsWith("REJECT")) { verdict = "REJECT"; feedback = review.verdict.trim(); }
    } catch (err) {
      console.error(`[aceforge/llm-gen] Workflow review failed: ${(err as Error).message}`);
      // Auto-approve on review failure — skill was generated successfully
      verdict = "APPROVE";
    }
  }

  return { skillMd: fixFrontmatterNesting(generatedMd), verdict: verdict as any, feedback, usedLlm: true };
}

// ─── Remediation skill generation ───────────────────────────────

interface GapInput {
  tool: string; gapType: string; severity: number; evidence: string[]; suggestedFocus: string;
  failureTraces: Array<{ args_summary?: string | null; error?: string | null; result_summary?: string | null }>;
  corrections: Array<{ text_fragment?: string; args_summary?: string | null }>;
}

export async function generateRemediationSkillWithLLm(gap: GapInput): Promise<GenerationResult | null> {
  const config = loadLlmConfig();
  if (!config.generatorKey) return null;

  const failureSamples = gap.failureTraces.slice(0, 5).map(t =>
    `  - Args: ${(t.args_summary || "(none)").slice(0, 80)}\n    Error: ${(t.error || t.result_summary || "unknown").toString().slice(0, 80)}`).join("\n");
  const correctionSamples = gap.corrections.slice(0, 5).map(c =>
    `  - "${(c.text_fragment || c.args_summary || "").toString().slice(0, 80)}"`).join("\n");

  const brief = `You are writing a REMEDIATION SKILL for an OpenClaw AI agent. This skill addresses a specific capability gap.

## Gap Analysis
Tool: ${gap.tool}
Gap type: ${gap.gapType.replace(/_/g, " ")}
Severity: ${gap.severity}
Focus: ${gap.suggestedFocus}

## Failure Patterns
${failureSamples || "None"}
## User Corrections
${correctionSamples || "None"}

## Requirements
- ANTI-PATTERNS section is the MOST IMPORTANT part
- Include pre-flight checks before executing
- Include error recovery with specific fallbacks
- Structure: When to Use → Pre-flight Checks → Instructions → Error Recovery → Anti-Patterns
- Category must be: remediation
- Keep under 150 lines

Output ONLY the raw SKILL.md content. No markdown fences, no preamble.`;

  let generatedMd: string;
  try {
    generatedMd = await callGenerator(config.generatorUrl, config.generatorKey, config.generatorModel, brief);
  } catch (err) {
    console.error(`[aceforge/llm-gen] Remediation generation failed: ${(err as Error).message}`);
    return null;
  }

  let verdict = "APPROVE";
  let feedback: string | undefined;
  if (config.reviewerKey) {
    try {
      const review = await callReviewer(config.reviewerUrl, config.reviewerKey, config.reviewerModel, buildReviewPrompt(generatedMd));
      const firstLine = review.verdict.trim().split("\n")[0].toUpperCase();
      if (firstLine.startsWith("REJECT")) { verdict = "REJECT"; feedback = review.verdict.trim(); }
    } catch (err) {
      console.error(`[aceforge/llm-gen] Remediation review failed: ${(err as Error).message}`);
      verdict = "APPROVE"; // explicit: review failure ≠ rejection
    }
  }

  return { skillMd: fixFrontmatterNesting(generatedMd), verdict: verdict as any, feedback, usedLlm: true };
}

// ─── Upgrade skill generation ───────────────────────────────────

interface QualityReportInput {
  structural: number; coverage: number; combined: number;
  deficiencies: string[]; strengths: string[];
}

export async function generateUpgradeSkillWithLLm(
  candidate: Candidate,
  existingSkillMd: string,
  qualityReport: QualityReportInput
): Promise<GenerationResult | null> {
  const config = loadLlmConfig();
  if (!config.generatorKey) return null;

  const { traces, corrections } = collectTracesForCandidate(candidate);
  const successSamples = traces.filter(t => t.success).slice(0, 5).map(t =>
    `  - Args: ${sanitizeTraceField(t.args_summary)}\n    Result: ${sanitizeTraceField(t.result_summary, 150)}`).join("\n");
  const failureSamples = traces.filter(t => !t.success).slice(0, 5).map(t =>
    `  - Args: ${sanitizeTraceField(t.args_summary)}\n    Error: ${sanitizeTraceField(t.error, 80)}`).join("\n");
  const correctionSamples = corrections.slice(0, 5).map(c =>
    `  - "${c.text_fragment || c.args_summary || ""}"`).join("\n");

  const brief = `You are UPGRADING an existing SKILL.md for an OpenClaw AI agent. The existing skill scored ${qualityReport.combined}/100.

## Deficiencies Found
${qualityReport.deficiencies.map(d => "- " + d).join("\n")}

## Strengths to Preserve
${qualityReport.strengths.map(s => "- " + s).join("\n")}

## Existing Skill
${existingSkillMd.slice(0, 2000)}

## Real Agent Usage Data
Tool: ${candidate.tool}
Occurrences: ${candidate.occurrences} across ${candidate.distinct_sessions} sessions
Success rate: ${Math.round(candidate.success_rate * 100)}%

### Successful Patterns
${successSamples || "None"}
### Failure Patterns
${failureSamples || "None"}
### User Corrections
${correctionSamples || "None"}

## Requirements
- KEEP what works, FIX every deficiency
- Structure: When to Use → Pre-flight Checks → Instructions → Error Recovery → Anti-Patterns
- Keep under 150 lines

Output ONLY the raw SKILL.md content. No markdown fences, no preamble.`;

  let generatedMd: string;
  try {
    generatedMd = await callGenerator(config.generatorUrl, config.generatorKey, config.generatorModel, brief);
    if (generatedMd.length > 50000) {
      console.error("[aceforge/llm-gen] Upgrade output exceeds 50KB safety limit");
      return null;
    }
  } catch (err) {
    console.error(`[aceforge/llm-gen] Upgrade generation failed: ${(err as Error).message}`);
    return null;
  }

  let verdict = "APPROVE";
  let feedback: string | undefined;
  if (config.reviewerKey) {
    try {
      const review = await callReviewer(config.reviewerUrl, config.reviewerKey, config.reviewerModel, buildReviewPrompt(generatedMd));
      const firstLine = review.verdict.trim().split("\n")[0].toUpperCase();
      if (firstLine.startsWith("REJECT")) { verdict = "REJECT"; feedback = review.verdict.trim(); }
    } catch (err) {
      console.error(`[aceforge/llm-gen] Upgrade review failed: ${(err as Error).message}`);
    }
  }

  return { skillMd: fixFrontmatterNesting(generatedMd), verdict: verdict as any, feedback, usedLlm: true };
}
