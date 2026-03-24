/**
 * Lifecycle management — activation tracking, retirement, reinstatement,
 * quality scoring, verification, and failure-driven revision
 *
 * v0.6.0 fixes:
 *  - H1: getHealthEntries now uses in-memory cache with TTL (was full-file read every call)
 *  - H2: getSkillStats uses last entry (was using first entry — wrong order)
 *  - H4: recordDeploymentBaseline now computes and stores baselineSuccessRate
 *  - L3: retireSkill/reinstateSkill use copy+delete (was renameSync — EXDEV on cross-volume)
 */
import * as fsSync from "fs";
import * as path from "path";

const FORGE_DIR = path.join(
  process.env.HOME || "~",
  ".openclaw",
  "workspace",
  ".forge"
);
const SKILLS_DIR = path.join(
  process.env.HOME || "~",
  ".openclaw",
  "workspace",
  "skills"
);
const RETIRED_DIR = path.join(FORGE_DIR, "retired");

export interface HealthEntry {
  ts: string;
  skill: string;
  action: string;
  success?: boolean;
  qualityScore?: number;
  baselineSuccessRate?: number;
  traceCountAtDeploy?: number;
  tool?: string;
  [key: string]: unknown;
}

// ─── Health entry cache (H1 fix) ────────────────────────────────────────
// Prevents re-reading the full JSONL on every tool call.
const healthCache = new Map<string, { entries: HealthEntry[]; ts: number }>();
const CACHE_TTL_MS = 5000;

export function invalidateHealthCache(skill?: string): void {
  if (skill) {
    healthCache.delete(skill);
    healthCache.delete("__all__");
  } else {
    healthCache.clear();
  }
}

// ─── Activation tracking ────────────────────────────────────────────────

export function recordActivation(skillName: string, success: boolean, qualityScore?: number): void {
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    skill: skillName,
    action: "activation",
    success,
    qualityScore: qualityScore ?? (success ? 1.0 : 0.0),
  }) + "\n";
  fsSync.appendFileSync(healthFile, entry);
  invalidateHealthCache(skillName);
}

export function getHealthEntries(skill?: string): HealthEntry[] {
  const cacheKey = skill || "__all__";
  const cached = healthCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.entries;

  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  if (!fsSync.existsSync(healthFile)) return [];
  const content = fsSync.readFileSync(healthFile, "utf-8");
  if (!content.trim()) return [];

  const allEntries = content
    .trim()
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line) as HealthEntry; } catch { return null; } })
    .filter(Boolean) as HealthEntry[];

  const result = skill ? allEntries.filter(e => e.skill === skill) : allEntries;
  healthCache.set(cacheKey, { entries: result, ts: Date.now() });
  return result;
}

export function getSkillStats(skillName: string): {
  activations: number;
  successRate: number;
  lastActivation: string | null;
  daysSinceActivation: number | null;
} {
  const entries = getHealthEntries(skillName).filter(e => e.action === "activation");
  if (entries.length === 0) {
    return { activations: 0, successRate: 0, lastActivation: null, daysSinceActivation: null };
  }
  const successes = entries.filter(e => e.success).length;
  // H2 fix: entries are in file-order (oldest first), so last element is most recent
  const lastEntry = entries[entries.length - 1];
  const lastTs = lastEntry?.ts || null;
  const daysSince = lastTs
    ? Math.floor((Date.now() - new Date(lastTs).getTime()) / (24 * 60 * 60 * 1000))
    : null;
  return {
    activations: entries.length,
    successRate: Math.round((successes / entries.length) * 100) / 100,
    lastActivation: lastTs,
    daysSinceActivation: daysSince,
  };
}

// ─── Quality scoring ─────────────────────────────────────────────────────

export function getSkillQualityScore(skillName: string): number {
  const entries = getHealthEntries(skillName).filter(e => e.action === "activation");
  if (entries.length === 0) return 0;
  const successes = entries.filter(e => e.success).length;
  return Math.round((successes / entries.length) * 100) / 100;
}

export function getFlaggedSkills(): string[] {
  const active = listActiveSkills();
  const flagged: string[] = [];

  for (const skill of active) {
    const entries = getHealthEntries(skill).filter(e => e.action === "activation");
    if (entries.length === 0) {
      // Check if skill is older than 30 days with zero activations
      const skillDir = path.join(SKILLS_DIR, skill);
      try {
        const stat = fsSync.statSync(skillDir);
        if (Date.now() - stat.ctimeMs > 30 * 24 * 60 * 60 * 1000) {
          flagged.push(skill);
        }
      } catch { /* skip */ }
      continue;
    }
    const score = getSkillQualityScore(skill);
    if (score < 0.5) flagged.push(skill);
  }

  return flagged;
}

// ─── Verification loop ───────────────────────────────────────────────────

export function recordVerification(skillName: string, passed: boolean, resultSummary: string): void {
  const verifFile = path.join(FORGE_DIR, "verifications.jsonl");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    skill: skillName,
    passed,
    result_summary: resultSummary.slice(0, 200),
  }) + "\n";
  fsSync.appendFileSync(verifFile, entry);
}

export function checkVerification(skillName: string): boolean | null {
  const verifFile = path.join(FORGE_DIR, "verifications.jsonl");
  if (!fsSync.existsSync(verifFile)) return null;

  const lines = fsSync.readFileSync(verifFile, "utf-8").trim().split("\n");
  const skillEntries = lines
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e: { skill: string }) => e.skill === skillName)
    .slice(-3);

  if (skillEntries.length < 3) return null;

  const failures = skillEntries.filter((e: { passed: boolean }) => !e.passed).length;
  if (failures >= 2) return false;
  const successes = skillEntries.filter((e: { passed: boolean }) => e.passed).length;
  if (successes === 3) return true;
  return null;
}

// ─── Failure-driven revision ───────────────────────────────────────────────

export function autoFlagForRevision(skillName: string, failureContext: string): void {
  const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
  if (!fsSync.existsSync(skillFile)) {
    console.warn(`[aceforge] cannot revise — skill not found: ${skillName}`);
    return;
  }

  const original = fsSync.readFileSync(skillFile, "utf-8");
  const lines = original.split("\n");

  let antiPatternsIdx = lines.findIndex(l => l.includes("## Anti-Patterns"));
  if (antiPatternsIdx === -1) {
    lines.push("\n## Anti-Patterns\n");
    antiPatternsIdx = lines.length - 1;
  }

  lines.splice(antiPatternsIdx + 1, 0,
    `- Failure observed: ${failureContext} (${new Date().toISOString().slice(0, 10)})`
  );

  const revised = lines.join("\n");
  const revName = `${skillName}-rev1`;
  const revDir = path.join(FORGE_DIR, "proposals", revName);
  fsSync.mkdirSync(revDir, { recursive: true });
  fsSync.writeFileSync(path.join(revDir, "SKILL.md"), revised, "utf-8");

  import("../notify.js").then(({ notify }) => {
    notify(
      `Skill Flagged for Revision\n` +
      `${skillName}\n` +
      `Cause: ${failureContext}\n` +
      `Review: /forge_approve ${revName}`
    ).catch(console.error);
  }).catch(console.error);
}

export function checkAndTriggerRevision(skillName: string): void {
  const entries = getHealthEntries(skillName)
    .filter(e => e.action === "activation")
    .slice(-10); // last 10 activations (file order = oldest first, slice from end)

  const failures = entries.filter(e => !e.success).length;
  if (failures >= 2) {
    autoFlagForRevision(skillName, `2+ failures in last ${entries.length} activations`);
  }
}

// ─── Diminishing returns detection ──────────────────────────────────────

const DEFAULT_DIMINISHING_THRESHOLD = 20;
const DEFAULT_THRESHOLD = 3;
const ESCALATED_THRESHOLD = 5;

export function getEffectiveCrystallizationThreshold(): number {
  const count = listActiveSkills().length;
  return count >= DEFAULT_DIMINISHING_THRESHOLD ? ESCALATED_THRESHOLD : DEFAULT_THRESHOLD;
}

// ─── Retirement / reinstatement (L3 fix: copy+delete, not rename) ───────

export function retireSkill(skillName: string): boolean {
  const skillsDir = path.join(SKILLS_DIR, skillName);
  const retiredDir = path.join(RETIRED_DIR, skillName);
  if (!fsSync.existsSync(skillsDir)) return false;
  fsSync.mkdirSync(retiredDir, { recursive: true });
  for (const file of fsSync.readdirSync(skillsDir)) {
    fsSync.copyFileSync(path.join(skillsDir, file), path.join(retiredDir, file));
  }
  fsSync.rmSync(skillsDir, { recursive: true, force: true });
  logHealth(skillName, "retired");
  return true;
}

export function reinstateSkill(skillName: string): boolean {
  const retiredDir = path.join(RETIRED_DIR, skillName);
  const skillsDir = path.join(SKILLS_DIR, skillName);
  if (!fsSync.existsSync(retiredDir)) return false;
  fsSync.mkdirSync(skillsDir, { recursive: true });
  for (const file of fsSync.readdirSync(retiredDir)) {
    fsSync.copyFileSync(path.join(retiredDir, file), path.join(skillsDir, file));
  }
  fsSync.rmSync(retiredDir, { recursive: true, force: true });
  logHealth(skillName, "reinstated");
  return true;
}

// ─── Listing helpers ────────────────────────────────────────────────────

export function listActiveSkills(): string[] {
  if (!fsSync.existsSync(SKILLS_DIR)) return [];
  return fsSync.readdirSync(SKILLS_DIR).filter(f => {
    try { return fsSync.statSync(path.join(SKILLS_DIR, f)).isDirectory(); }
    catch { return false; }
  });
}

export function listRetiredSkills(): string[] {
  if (!fsSync.existsSync(RETIRED_DIR)) return [];
  return fsSync.readdirSync(RETIRED_DIR).filter(f => {
    try { return fsSync.statSync(path.join(RETIRED_DIR, f)).isDirectory(); }
    catch { return false; }
  });
}

export function listProposals(): string[] {
  const proposalsDir = path.join(FORGE_DIR, "proposals");
  if (!fsSync.existsSync(proposalsDir)) return [];
  return fsSync.readdirSync(proposalsDir).filter(f => {
    try { return fsSync.statSync(path.join(proposalsDir, f)).isDirectory(); }
    catch { return false; }
  });
}

// ─── Proposal expiry ────────────────────────────────────────────────────

export function expireOldProposals(notifyFn?: (msg: string) => Promise<void>): void {
  const proposalsDir = path.join(FORGE_DIR, "proposals");
  if (!fsSync.existsSync(proposalsDir)) return;

  const now = Date.now();
  const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

  for (const name of fsSync.readdirSync(proposalsDir)) {
    const propDir = path.join(proposalsDir, name);
    try {
      if (!fsSync.statSync(propDir).isDirectory()) continue;
      if (now - fsSync.statSync(propDir).mtimeMs < EXPIRY_MS) continue;
    } catch { continue; }

    fsSync.rmSync(propDir, { recursive: true, force: true });
    console.log(`[aceforge] proposal expired: ${name}`);
    if (notifyFn) {
      notifyFn(`Proposal expired: ${name}\nNo response in 7 days.`);
    }
  }
}

// ─── Deployment baselines (H4 fix: compute + store baselineSuccessRate) ──

export function recordDeploymentBaseline(skillName: string, toolName: string): void {
  const pFile = path.join(FORGE_DIR, "patterns.jsonl");
  let baselineRate = 0;
  let traceCount = 0;

  if (fsSync.existsSync(pFile)) {
    const content = fsSync.readFileSync(pFile, "utf-8").trim();
    if (content) {
      const lines = content.split("\n").filter(l => l.trim().length > 0);
      const toolTraces: Array<{ success: boolean }> = [];
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.tool === toolName && e.type !== "correction" && e.type !== "chain") {
            toolTraces.push(e);
          }
        } catch { /* skip */ }
      }
      traceCount = toolTraces.length;
      if (traceCount > 0) {
        const successes = toolTraces.filter(t => t.success).length;
        baselineRate = Math.round((successes / traceCount) * 100) / 100;
      }
    }
  }

  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    skill: skillName,
    action: "deployment_baseline",
    tool: toolName,
    traceCountAtDeploy: traceCount,
    baselineSuccessRate: baselineRate,
  }) + "\n";
  fsSync.appendFileSync(healthFile, entry);
  invalidateHealthCache(skillName);
}

export function checkEffectivenessVsBaseline(skillName: string): { improved: boolean; delta: number } | null {
  const entries = getHealthEntries(skillName);
  const baseline = entries.find(e => e.action === "deployment_baseline");
  if (!baseline) return null;

  const activations = entries.filter(e => e.action === "activation");
  if (activations.length < 50) return null;

  const successes = activations.filter(e => e.success).length;
  const currentRate = successes / activations.length;
  const baselineRate = baseline.baselineSuccessRate || 0;
  const delta = currentRate - baselineRate;

  return { improved: delta >= 0, delta: Math.round(delta * 100) };
}

// ─── Skill Effectiveness Watchdog ─────────────────────────────────────

export interface WatchdogAlert {
  skill: string;
  reason: string;
  activations: number;
  successRate: number;
  baselineRate: number;
}

export function runEffectivenessWatchdog(): WatchdogAlert[] {
  const alerts: WatchdogAlert[] = [];
  if (!fsSync.existsSync(SKILLS_DIR)) return alerts;

  const dirs = fsSync.readdirSync(SKILLS_DIR).filter(d => {
    try { return fsSync.statSync(path.join(SKILLS_DIR, d)).isDirectory(); }
    catch { return false; }
  });

  // A/B comparison for versioned variants
  for (const skill of dirs) {
    const versionMatch = skill.match(/^(.+?)(?:-v(\d+)|-rev(\d+))$/);
    if (versionMatch && dirs.includes(versionMatch[1])) {
      const baseName = versionMatch[1];
      const comparison = compareSkillVersions(baseName, skill);
      if (comparison && comparison.winner) {
        const loser = comparison.winner === skill ? baseName : skill;
        alerts.push({
          skill: loser,
          reason: "no_improvement",
          activations: comparison.winner === skill ? comparison.oldCount : comparison.newCount,
          successRate: comparison.winner === skill ? comparison.oldRate : comparison.newRate,
          baselineRate: comparison.winner === skill ? comparison.newRate : comparison.oldRate,
        });
      }
    }
  }

  const alertedSkills = new Set(alerts.map(a => a.skill));

  for (const skill of dirs) {
    if (alertedSkills.has(skill)) continue;
    const entries = getHealthEntries(skill).filter(e => e.action === "activation");
    if (entries.length < 50) continue;

    const successes = entries.filter(e => e.success).length;
    const currentRate = successes / entries.length;

    const allEntries = getHealthEntries(skill);
    const baseline = allEntries.find(e => e.action === "deployment_baseline");
    const baselineRate = baseline?.baselineSuccessRate || 0;

    // Alert if no improvement over baseline after 50 activations
    if (baselineRate > 0 && currentRate <= baselineRate) {
      alerts.push({
        skill,
        reason: "no_improvement",
        activations: entries.length,
        successRate: Math.round(currentRate * 100) / 100,
        baselineRate: Math.round(baselineRate * 100) / 100,
      });
    }

    // Alert if success rate dropped below 50%
    if (currentRate < 0.5 && entries.length >= 50 && !alerts.some(a => a.skill === skill)) {
      alerts.push({
        skill,
        reason: "degraded",
        activations: entries.length,
        successRate: Math.round(currentRate * 100) / 100,
        baselineRate: Math.round(baselineRate * 100) / 100,
      });
    }
  }

  return alerts;
}

// ─── Skill Registry (MetaClaw/OpenClaw-RL integration) ───────────────

export function getSkillRegistry(): Array<{
  name: string;
  successRate: number;
  activationCount: number;
  source: string;
  path: string;
}> {
  if (!fsSync.existsSync(SKILLS_DIR)) return [];

  const dirs = fsSync.readdirSync(SKILLS_DIR).filter(d => {
    try { return fsSync.statSync(path.join(SKILLS_DIR, d)).isDirectory(); }
    catch { return false; }
  });

  return dirs.map(name => {
    const entries = getHealthEntries(name).filter(e => e.action === "activation");
    const successes = entries.filter(e => e.success).length;
    return {
      name,
      successRate: entries.length > 0 ? Math.round((successes / entries.length) * 100) / 100 : 0,
      activationCount: entries.length,
      source: "aceforge",
      path: path.join(SKILLS_DIR, name, "SKILL.md"),
    };
  });
}

export function getRewardSignals(): Record<string, { successRate: number; count: number; lastUpdated: string }> {
  const registry = getSkillRegistry();
  const signals: Record<string, { successRate: number; count: number; lastUpdated: string }> = {};
  for (const skill of registry) {
    const entries = getHealthEntries(skill.name);
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    signals[skill.name] = {
      successRate: skill.successRate,
      count: skill.activationCount,
      lastUpdated: lastEntry?.ts || new Date().toISOString(),
    };
  }
  return signals;
}

// ─── A/B Skill Comparison ─────────────────────────────────────────────

export function compareSkillVersions(
  oldSkill: string,
  newSkill: string
): { winner: string | null; oldRate: number; newRate: number; oldCount: number; newCount: number } | null {
  const oldEntries = getHealthEntries(oldSkill).filter(e => e.action === "activation");
  const newEntries = getHealthEntries(newSkill).filter(e => e.action === "activation");

  if (oldEntries.length < 25 || newEntries.length < 25) return null;

  const oldSuccess = oldEntries.filter(e => e.success).length;
  const newSuccess = newEntries.filter(e => e.success).length;
  const oldRate = oldSuccess / oldEntries.length;
  const newRate = newSuccess / newEntries.length;

  let winner: string | null = null;
  if (newRate - oldRate > 0.05) winner = newSkill;
  else if (oldRate - newRate > 0.05) winner = oldSkill;

  return {
    winner,
    oldRate: Math.round(oldRate * 100) / 100,
    newRate: Math.round(newRate * 100) / 100,
    oldCount: oldEntries.length,
    newCount: newEntries.length,
  };
}

// ─── Internal ───────────────────────────────────────────────────────────

function logHealth(skill: string, action: string): void {
  const healthFile = path.join(FORGE_DIR, "skill-health.jsonl");
  const entry = JSON.stringify({ ts: new Date().toISOString(), skill, action }) + "\n";
  fsSync.appendFileSync(healthFile, entry);
  invalidateHealthCache(skill);
}
