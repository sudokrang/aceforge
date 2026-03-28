/**
 * Native Tool Analysis — Argument-pattern clustering for built-in OpenClaw tools
 *
 * v0.8.1: Extracted from analyze.ts
 *
 * v0.7.6: Introduced argument-pattern clustering. Instead of proposing skills
 * for "exec" (which is a native tool), we cluster by domain:
 *   exec+docker args → "exec-docker"
 *   exec+ssh args → "exec-ssh"
 *   read+.ts files → "read-code"
 *
 * Structural approach:
 *   A. Canonical naming: {tool}-{domain} — LLM writes content, AceForge controls name
 *   B. Tool-level gating: if ANY {tool}-* proposal exists, skip entirely
 *   C. Max 1 per tool per cycle (strongest by occurrence count)
 */
import * as fsSync from "fs";
import { appendJsonl } from "./store.js";
import { notify } from "../notify.js";
import { bold, mono } from "../notify-format.js";
import { writeProposal } from "../skill/generator.js";
import { validateSkillMd } from "../skill/validator.js";
import { generateSkillWithLLm } from "../skill/llm-generator.js";
import {
  NATIVE_TOOLS, PROPOSALS_DIR,
  type PatternEntry,
} from "./constants.js";
import {
  logFilteredCandidate,
  hasActiveProposalOrSkill,
  hasExistingProposal,
} from "./analyze-utils.js";

// ─── Types ──────────────────────────────────────────────────────────────

interface SubPatternGroup {
  tool: string;
  domain: string;
  skillName: string;
  entries: PatternEntry[];
}

// ─── Domain Prefix Extraction ───────────────────────────────────────────
// Exported: used by llm-generator.ts for domain-filtered trace collection

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

// ─── Sub-Pattern Clustering ─────────────────────────────────────────────

export function clusterNativeToolPatterns(
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

// ─── Native Tool Candidate Handler ──────────────────────────────────────
// Handles the NATIVE_TOOLS branch of the analysis loop.
// Returns true if the tool was handled (caller should `continue`).

export async function handleNativeToolCandidate(
  key: string,
  entries: PatternEntry[],
  effectiveThreshold: number
): Promise<boolean> {
  if (!NATIVE_TOOLS.has(key)) return false;

  // B: Check if ANY proposal already exists for this native tool
  const existingNativeProposals = fsSync.existsSync(PROPOSALS_DIR)
    ? fsSync.readdirSync(PROPOSALS_DIR).filter(p => p.startsWith(key + "-"))
    : [];
  if (existingNativeProposals.length > 0) {
    logFilteredCandidate(key, "native_pending_proposal", `${existingNativeProposals.length} pending proposal(s): ${existingNativeProposals.slice(0, 3).join(", ")}`, { existingProposals: existingNativeProposals });
    return true;
  }

  const subPatterns = clusterNativeToolPatterns(key, entries, effectiveThreshold);
  if (subPatterns.length === 0) {
    logFilteredCandidate(key, "native_no_subpattern", `${entries.length} entries but no qualifying domain clusters`, { occurrences: entries.length });
    return true;
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
    return true;
  }
  if (hasExistingProposal(canonicalName)) {
    logFilteredCandidate(canonicalName, "native_proposal_exists", "proposal already pending");
    return true;
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
        return true;
      }
      writeProposal(canonicalName, llmResult.skillMd);
      appendJsonl("candidates.jsonl", { ...candidate, type: "native-subpattern", domain: sp.domain, canonicalName });

      const descMatch = llmResult.skillMd.match(/^description:\s*["']?(.+?)["']?$/m);
      const summary = descMatch ? descMatch[1].slice(0, 120) : canonicalName;

      notify(
        `📋 ${bold("New Skill Proposal")}\n\n` +
        `${bold(canonicalName)}\n` +
        `Your agent ran ${mono(key)} in the ${sp.domain} domain ${sp.entries.length} times across ${spSessions.size} session${spSessions.size !== 1 ? "s" : ""} (${Math.round(spSuccessRate * 100)}% success)\n` +
        (summary ? `\n${summary}` : "") + `\n\n` +
        `${mono("/forge preview " + canonicalName)}\n${mono("/forge approve " + canonicalName)}\n${mono("/forge reject " + canonicalName)}`
      ).catch(err => console.error("[aceforge] notify error:", err));

      console.log(`[aceforge] sub-pattern proposal written: ${canonicalName}`);
    } else {
      console.log(`[aceforge] sub-pattern ${canonicalName} rejected by LLM`);
    }
  } catch (err) {
    console.error(`[aceforge] sub-pattern generation error for ${canonicalName}:`, err);
    logFilteredCandidate(canonicalName, "subpattern_error", `Sub-pattern generation failed: ${(err as Error).message?.slice(0, 100) || "unknown"}`, { occurrences: sp.entries.length });
  }

  return true;
}
