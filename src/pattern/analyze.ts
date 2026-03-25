/**
 * Pattern analysis engine
 *
 * v0.7.2 fixes:
 *   N-M1: bundledTools dedup now parses YAML frontmatter (was trying JSON regex)
 *   N-M5: uses shared ACEFORGE_TOOL_BLOCKLIST
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { appendJsonl } from "./store.js";
import { notify } from "../notify.js";
import { generateSkillFromCandidate, writeProposal } from "../skill/generator.js";
import { validateSkillMd } from "../skill/validator.js";
import { generateSkillWithLLm, reviseSkillWithLLm, generateWorkflowSkillWithLLm, generateRemediationSkillWithLLm } from "../skill/llm-generator.js";
import { detectGaps } from "./gap-detect.js";
import { scoreSkill } from "../skill/quality-score.js";
import { llmJudgeEvaluate } from "../skill/llm-judge.js";
import { getEffectiveCrystallizationThreshold, getHealthEntries } from "../skill/lifecycle.js";

const ACEFORGE_TOOL_BLOCKLIST = new Set([
  "forge", "forge_status", "forge_reflect", "forge_propose",
  "forge_approve_skill", "forge_reject_skill", "forge_quality",
  "forge_approve", "forge_reject", "forge_retire", "forge_reinstate",
  "forge_registry", "forge_rewards", "forge_gaps",
  "forge_retire_skill", "forge_tree", "forge_cross_session", "forge_compose",
  "forge_behavior_gaps", "forge_optimize",
  "forge_test", "forge_challenge", "forge_adversarial",
  "sessions_spawn", "sessions_list", "sessions_send", "sessions_history",
  "process", "message", "notify",
]);

const SELF_TOOLS = new Set([
  "exec", "write", "edit", "delete", "move", "copy",
  "read", "pdf", "image", "browser", "web_fetch", "web_search",
  "session_send", "sessions_send", "broadcast",
  "message", "notify", "process", "exec-ssh",
  "memory_search", "memory_recall", "memory_store",
  "file_head", "file_write", "file_read",
  ...ACEFORGE_TOOL_BLOCKLIST,
]);

// F2 fix: Native OpenClaw tools — never propose skills for these
const NATIVE_TOOLS = new Set([
  "exec", "write", "edit", "delete", "move", "copy",
  "read", "pdf", "image", "browser", "web_fetch", "web_search",
  "session_send", "sessions_send", "broadcast",
  "message", "notify", "process", "exec-ssh",
  "memory_search", "memory_recall", "memory_store",
  "file_head", "file_write", "file_read",
  "apply_patch", "grep", "glob", "list_directory",
  "tavily_search", "tavily_extract",
  "gateway",
  ...ACEFORGE_TOOL_BLOCKLIST,
]);


const HOME = os.homedir() || process.env.HOME || "";

const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
const PROPOSALS_DIR = path.join(FORGE_DIR, "proposals");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SUCCESS_RATE_MIN = 0.40;

interface PatternEntry {
  ts: string;
  tool: string;
  args_summary: string | null;
  success: boolean;
  session: string | null;
  type?: string;
  result_summary?: string | null;
  error?: string | null;
  tools?: string[];
  [key: string]: unknown;
}

function readCandidatesFile(): { tool: string; args_summary_prefix: string }[] {
  const file = path.join(FORGE_DIR, "candidates.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as { tool: string; args_summary_prefix: string }[];
}

function readPatternsFile(): PatternEntry[] {
  const file = path.join(FORGE_DIR, "patterns.jsonl");
  if (!fsSync.existsSync(file)) return [];
  const content = fsSync.readFileSync(file, "utf-8");
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line) as PatternEntry; } catch { return null; } })
    .filter(Boolean) as PatternEntry[];
}


// ═══ v0.7.6: Argument-pattern clustering for native tools ═══
// Extracts a domain prefix from tool arguments to enable sub-pattern clustering.
// exec with docker args → "docker", exec with ssh args → "ssh", etc.

export function extractDomainPrefix(toolName: string, argsSummary: string | null): string | null {
  if (!argsSummary) return null;
  const args = argsSummary.toLowerCase();

  // For exec/exec-ssh: extract the command being run
  if (toolName === "exec" || toolName === "exec-ssh") {
    // JSON args: {"command":"docker ps"} or {"command":"ssh nas ..."}
    try {
      const parsed = JSON.parse(argsSummary);
      const cmd = (parsed.command || parsed.cmd || "").trim();
      if (!cmd) return null;
      // Extract first word of the command
      const firstWord = cmd.split(/\s+/)[0].replace(/^.*\//, ""); // strip path prefix
      // Map common commands to domain prefixes
      const domainMap: Record<string, string> = {
        docker: "docker", "docker-compose": "docker", podman: "docker",
        ssh: "ssh", scp: "ssh", rsync: "ssh",
        git: "git", gh: "git",
        npm: "npm", npx: "npm", pnpm: "npm", yarn: "npm", node: "npm",
        python: "python", python3: "python", pip: "python", pip3: "python",
        systemctl: "systemd", service: "systemd", journalctl: "systemd",
        kubectl: "k8s", helm: "k8s",
        curl: "http", wget: "http", fetch: "http",
        apt: "apt", "apt-get": "apt", brew: "brew",
        tar: "archive", gzip: "archive", unzip: "archive",
        grep: "search", find: "search", rg: "search",
        ls: null, cd: null, pwd: null, echo: null, cat: null, // too generic
      };
      if (firstWord in domainMap) return domainMap[firstWord];
      // If command targets a known host pattern, use that
      if (/\b(?:nas|synology|192\.168\.)/.test(cmd)) return "nas";
      if (/\b(?:netsuite|suiteql)/.test(cmd)) return "netsuite";
      // Default: use the command itself if it's specific enough
      if (firstWord.length >= 3 && firstWord.length <= 20) return firstWord;
      return null;
    } catch {
      // Non-JSON args — try extracting first meaningful token
      const tokens = args.replace(/[{}":\[\]]/g, " ").split(/\s+/).filter(t => t.length >= 3);
      if (tokens.length > 0) {
        const first = tokens[0];
        if (/docker|ssh|git|npm|python|systemctl|curl/.test(first)) return first;
      }
      return null;
    }
  }

  // For read/write: extract file extension or path pattern
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    try {
      const parsed = JSON.parse(argsSummary);
      const filePath = (parsed.path || parsed.file || "").toLowerCase();
      if (!filePath) return null;
      // Classify by extension
      if (/\.json$/.test(filePath)) return "config";
      if (/\.ya?ml$/.test(filePath)) return "config";
      if (/\.ts$|\.js$|\.tsx$|\.jsx$/.test(filePath)) return "code";
      if (/\.py$/.test(filePath)) return "python";
      if (/\.md$/.test(filePath)) return "docs";
      if (/\.csv$|\.xlsx?$/.test(filePath)) return "data";
      if (/\.log$/.test(filePath)) return "logs";
      if (/dockerfile|docker-compose/i.test(filePath)) return "docker";
      // Classify by path pattern
      if (/\.openclaw/.test(filePath)) return "openclaw-config";
      if (/\/etc\//.test(filePath)) return "system-config";
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

interface SubPatternGroup {
  tool: string;
  domain: string;
  skillName: string;
  entries: PatternEntry[];
}

function clusterNativeToolPatterns(
  tool: string,
  entries: PatternEntry[],
  effectiveThreshold: number
): SubPatternGroup[] {
  const clusters = new Map<string, PatternEntry[]>();

  for (const e of entries) {
    const domain = extractDomainPrefix(tool, e.args_summary);
    if (!domain) continue; // unclassifiable — skip
    if (!clusters.has(domain)) clusters.set(domain, []);
    clusters.get(domain)!.push(e);
  }

  const qualifying: SubPatternGroup[] = [];
  for (const [domain, clusterEntries] of clusters) {
    if (clusterEntries.length < effectiveThreshold) continue;

    // Apply same temporal spread gate
    const sessions = new Set(clusterEntries.map(e => e.session).filter(Boolean));
    const distinctDays = new Set(clusterEntries.map(e => new Date(e.ts).toISOString().slice(0, 10))).size;
    const distinctHours = new Set(clusterEntries.map(e => new Date(e.ts).toISOString().slice(0, 13))).size;
    if (sessions.size < 2 && distinctDays < 2 && distinctHours < 2) continue;

    // Apply success rate gate
    const successes = clusterEntries.filter(e => e.success).length;
    const successRate = successes / clusterEntries.length;
    if (successRate < 0.40) continue;

    qualifying.push({
      tool,
      domain,
      skillName: `${tool}-${domain}`,
      entries: clusterEntries,
    });
  }

  return qualifying;
}


// ═══ v0.7.6: Filtered candidate logging ═══
// Every time a candidate is suppressed by a quality gate, log WHY
// so operators can review with /forge filtered

function logFilteredCandidate(
  tool: string,
  reason: string,
  detail: string,
  meta?: Record<string, unknown>
): void {
  appendJsonl("filtered-candidates.jsonl", {
    ts: new Date().toISOString(),
    tool,
    reason,
    detail,
    ...meta,
  });
  console.log(`[aceforge] filtered: ${tool} — ${reason}: ${detail}`);
}

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

/**
 * M3 fix: Check if a tool has an ACTIVE proposal or deployed skill.
 * N-M1 fix: bundledTools parsed from YAML frontmatter, not JSON.
 */
function hasActiveProposalOrSkill(tool: string): boolean {
  // Check proposals directory
  if (fsSync.existsSync(PROPOSALS_DIR)) {
    const proposals = fsSync.readdirSync(PROPOSALS_DIR);
    if (proposals.some(p => p === tool || p.startsWith(tool + "-"))) return true;
  }
  // Check deployed skills
  if (fsSync.existsSync(SKILLS_DIR)) {
    const skills = fsSync.readdirSync(SKILLS_DIR);
    if (skills.some(s => {
      try { return fsSync.statSync(path.join(SKILLS_DIR, s)).isDirectory() && (s === tool || s.startsWith(tool + "-")); }
      catch { return false; }
    })) return true;
  }
  // N-M1 fix: Check if any installed skill explicitly wraps this tool via bundledTools
  // SKILL.md uses YAML frontmatter, not JSON — parse accordingly
  if (fsSync.existsSync(SKILLS_DIR)) {
    const skills = fsSync.readdirSync(SKILLS_DIR);
    for (const s of skills) {
      try {
        const skillPath = path.join(SKILLS_DIR, s);
        if (!fsSync.statSync(skillPath).isDirectory()) continue;
        const mdPath = path.join(skillPath, "SKILL.md");
        if (!fsSync.existsSync(mdPath)) continue;
        const content = fsSync.readFileSync(mdPath, "utf-8");

        // Parse bundledTools from YAML frontmatter:
        //   bundledTools: [tavily_search, tavily_extract]
        // or:
        //   bundledTools:
        //     - tavily_search
        //     - tavily_extract
        const inlineMatch = content.match(/bundledTools:\s*\[([^\]]+)\]/);
        if (inlineMatch) {
          const tools = inlineMatch[1].split(",").map(t => t.trim().replace(/['"]/g, ""));
          if (tools.includes(tool)) return true;
        }
        // Multi-line YAML array
        const multiLineMatch = content.match(/bundledTools:\s*\n((?:\s+-\s+\S+\n?)+)/);
        if (multiLineMatch) {
          const tools = multiLineMatch[1].split("\n")
            .map(l => l.replace(/^\s*-\s*/, "").trim().replace(/['"]/g, ""))
            .filter(Boolean);
          if (tools.includes(tool)) return true;
        }

        // Fallback: check if description mentions the tool (heuristic)
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?$/m);
        if (descMatch && descMatch[1].toLowerCase().includes(tool.replace(/_/g, " ").toLowerCase())) {
          return true;
        }
      } catch { /* skip unreadable skills */ }
    }
  }
  return false;
}

/** Find the deployed skill name that matches a tool, if any */
function findDeployedSkill(tool: string): string | null {
  if (!fsSync.existsSync(SKILLS_DIR)) return null;
  return fsSync.readdirSync(SKILLS_DIR).find(s => {
    try { return fsSync.statSync(path.join(SKILLS_DIR, s)).isDirectory() && (s === tool || s.startsWith(tool + "-")); }
    catch { return false; }
  }) || null;
}


/** F1 fix: Check if any existing PROPOSAL already covers this tool */
function hasProposalForSameTool(tool: string): string | null {
  if (!fsSync.existsSync(PROPOSALS_DIR)) return null;
  for (const proposalName of fsSync.readdirSync(PROPOSALS_DIR)) {
    const propDir = path.join(PROPOSALS_DIR, proposalName);
    try {
      if (!fsSync.statSync(propDir).isDirectory()) continue;
      const mdPath = path.join(propDir, "SKILL.md");
      if (!fsSync.existsSync(mdPath)) continue;
      const content = fsSync.readFileSync(mdPath, "utf-8");

      // Check bundledTools
      const inlineMatch = content.match(/bundledTools:\s*\[([^\]]+)\]/);
      if (inlineMatch) {
        const tools = inlineMatch[1].split(",").map(t => t.trim().replace(/['"]/g, ""));
        if (tools.includes(tool)) return proposalName;
      }
      const multiLineMatch = content.match(/bundledTools:\s*\n((?:\s+-\s+\S+\n?)+)/);
      if (multiLineMatch) {
        const tools = multiLineMatch[1].split("\n")
          .map(l => l.replace(/^\s*-\s*/, "").trim().replace(/['"]/g, ""))
          .filter(Boolean);
        if (tools.includes(tool)) return proposalName;
      }

      // Check if proposal name maps to this tool
      const prefix = proposalName.replace(/-(guard|skill|v\d+|rev\d+|upgrade|operations|workflow).*$/, "");
      if (prefix === tool) return proposalName;
    } catch { /* skip */ }
  }
  return null;
}

/** Check if a proposal already exists for this name */
function hasExistingProposal(name: string): boolean {
  if (!fsSync.existsSync(PROPOSALS_DIR)) return false;
  return fsSync.readdirSync(PROPOSALS_DIR).some(p => p === name || p.startsWith(name));
}

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
    if (NATIVE_TOOLS.has(key)) {
      // v0.7.6 fix: Structural approach to native tool sub-patterns
      // A. Canonical naming: {tool}-{domain} — LLM writes content, AceForge controls name
      // B. Tool-level gating: if ANY {tool}-* proposal exists, skip entirely
      // C. Max 1 per tool per cycle (strongest by occurrence count)

      // B: Check if ANY proposal already exists for this native tool
      const existingNativeProposals = fsSync.existsSync(PROPOSALS_DIR)
        ? fsSync.readdirSync(PROPOSALS_DIR).filter(p => p.startsWith(key + "-"))
        : [];
      if (existingNativeProposals.length > 0) {
        logFilteredCandidate(key, "native_pending_proposal", `${existingNativeProposals.length} pending proposal(s): ${existingNativeProposals.slice(0, 3).join(", ")}`, { existingProposals: existingNativeProposals });
        continue;
      }

      const subPatterns = clusterNativeToolPatterns(key, entries, effectiveThreshold);
      if (subPatterns.length === 0) {
        logFilteredCandidate(key, "native_no_subpattern", `${entries.length} entries but no qualifying domain clusters`, { occurrences: entries.length });
        continue;
      }

      // C: Pick the strongest sub-pattern only (highest occurrence count)
      const strongest = subPatterns.sort((a, b) => b.entries.length - a.entries.length)[0];
      const sp = strongest;

      // A: Canonical name — deterministic, not LLM-generated
      const canonicalName = `${key}-${sp.domain}`;

      const spSessions = new Set(sp.entries.map(e => e.session).filter(Boolean));
      const spSuccesses = sp.entries.filter(e => e.success).length;
      const spSuccessRate = spSuccesses / sp.entries.length;

      // Check canonical name against deployed skills and proposals
      if (hasActiveProposalOrSkill(canonicalName)) {
        logFilteredCandidate(canonicalName, "native_skill_exists", "deployed skill or proposal already exists");
        continue;
      }
      if (hasExistingProposal(canonicalName)) {
        logFilteredCandidate(canonicalName, "native_proposal_exists", "proposal already pending");
        continue;
      }

      console.log(`[aceforge] native sub-pattern: ${canonicalName} (${sp.entries.length}x, ${spSessions.size} sessions, ${sp.domain} domain)`);

      const candidate = {
        ts: new Date().toISOString(),
        tool: key,
        args_summary_prefix: sp.entries[0].args_summary?.slice(0, 50) || "",
        occurrences: sp.entries.length,
        success_rate: Math.round(spSuccessRate * 100) / 100,
        distinct_sessions: spSessions.size,
        first_seen: sp.entries[sp.entries.length - 1].ts,
        last_seen: sp.entries[0].ts,
        domainFilter: sp.domain,  // Filter traces to this domain only
      };

      try {
        const llmResult = await generateSkillWithLLm(candidate);
        if (llmResult && llmResult.verdict !== "REJECT") {
          // A: Ignore LLM's chosen name — use canonical name
          const validation = validateSkillMd(llmResult.skillMd, canonicalName);
          if (validation.errors.some((e: string) => e.startsWith("BLOCKED:"))) {
            console.log(`[aceforge] sub-pattern ${canonicalName} blocked by validator`);
            continue;
          }
          writeProposal(canonicalName, llmResult.skillMd);
          appendJsonl("candidates.jsonl", { ...candidate, type: "native-subpattern", domain: sp.domain, canonicalName });

          const descMatch = llmResult.skillMd.match(/^description:\s*["']?(.+?)["']?$/m);
          const summary = descMatch ? descMatch[1].slice(0, 120) : canonicalName;

          notify(
            `Native Tool Sub-Pattern Proposal\n` +
            `${canonicalName}\n` +
            `Tool: ${key} (${sp.domain} domain)\n` +
            `${sp.entries.length}x, ${Math.round(spSuccessRate * 100)}% success, ${spSessions.size} sessions\n` +
            `Summary: ${summary}\n` +
            `Use: /forge approve ${canonicalName}  or  /forge reject ${canonicalName}`
          ).catch(err => console.error("[aceforge] notify error:", err));

          console.log(`[aceforge] sub-pattern proposal written: ${canonicalName}`);
        } else {
          console.log(`[aceforge] sub-pattern ${canonicalName} rejected by LLM`);
        }
      } catch (err) {
        console.error(`[aceforge] sub-pattern generation error for ${canonicalName}:`, err);
        logFilteredCandidate(canonicalName, "subpattern_error", `Sub-pattern generation failed: ${(err as Error).message?.slice(0, 100) || "unknown"}`, { occurrences: sp.entries.length });
      }
      continue;
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

        if (newTraceCount >= 50 && !hasExistingProposal(key + "-") && !hasExistingProposal(deployedSkill + "-v")) {
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
                `Skill Evolution Proposal\n` +
                `${evoName} (replaces ${deployedSkill})\n` +
                `Tool: ${key}\n` +
                `${newTraceCount} new traces since deployment\n` +
                `Summary: ${summary}\n` +
                `Use: /forge approve ${evoName}  or  /forge reject ${evoName}`
              ).catch(err => console.error("[aceforge] notify error:", err));
              evolutionProposed = true;
            }
          } catch (evoErr) {
            console.error(`[aceforge] evolution error: ${(evoErr as Error).message}`);
            logFilteredCandidate(key, "evolution_error", `Evolution generation failed: ${(evoErr as Error).message?.slice(0, 100) || "unknown"}`, { occurrences: entries.length });
          }
        }
      }

      // H5 fix: If evolution didn't fire, fall through to upgrade scoring
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
              `Skill Upgrade Proposal\n` +
              `${upgradeName} (replaces ${deployedSkill})\n` +
              `Current score: ${finalScore}/100\n` +
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
    // Signal: 2+ sessions OR 2+ distinct days OR 2+ distinct hours with gaps
    // A build burst is 10 calls in 5 min. Organic usage spans hours.
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
}

// ═══ Chain-to-Workflow Skill Proposals ═══

async function analyzeChains(patterns: PatternEntry[]): Promise<void> {
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

// ═══ Gap Analysis → Remediation Skill Proposals ═══

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
        `Gap Remediation Proposal\n` +
        `${skillName}\n` +
        `Tool: ${gap.tool} | Severity: ${severityLabel}\n` +
        `Gap: ${gap.gapType.replace(/_/g, " ")}\n` +
        `${gap.evidence.slice(0, 2).join("; ")}` +
        notesSuffix + `\n` +
        `Use: /forge approve ${skillName}  or  /forge reject ${skillName}`
      ).catch(err => console.error("[aceforge] notify error:", err));

      console.log(`[aceforge] remediation proposal written: ${skillName}`);
    } catch (err) {
      console.error(`[aceforge] remediation generation error for ${gap.tool}:`, err);
    }
  }
}
