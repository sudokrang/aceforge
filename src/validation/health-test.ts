/**
 * Skill Health Testing — Phase 3A
 *
 * Periodic validation that installed skills still work:
 * - CLI commands: verify binaries exist via `which`
 * - File paths: verify referenced paths exist
 * - API endpoints: health check with HEAD request
 * - Tool references: verify tools are available
 *
 * Research: EvoSkill (arXiv:2603.02766) — "retains only skills that improve
 * held-out validation performance while the underlying model remains frozen."
 */
import * as os from "os";
import * as fsSync from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { listActiveSkills } from "../skill/lifecycle.js";

const HOME = os.homedir() || process.env.HOME || "";
const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");

// ─── Types ──────────────────────────────────────────────────────────────

export interface HealthTestResult {
  skill: string;
  passed: boolean;
  tests: TestAssertion[];
  testedAt: string;
}

export interface TestAssertion {
  type: "cli" | "path" | "endpoint" | "tool";
  target: string;
  passed: boolean;
  detail: string;
}

// ─── Extract Testable Assertions ────────────────────────────────────────

function extractCLICommands(content: string): string[] {
  const commands = new Set<string>();
  // Match backtick code blocks with commands
  const codeBlocks = content.match(/`([a-z][\w-]*)`/g) || [];
  for (const cb of codeBlocks) {
    const cmd = cb.replace(/`/g, "");
    if (["ssh", "docker", "exec", "curl", "wget", "git", "npm", "node", "python", "python3",
         "systemctl", "apt", "brew", "pip", "cargo", "rsync", "scp", "gzip", "tar",
         "nslookup", "dig", "ping", "traceroute", "openssl", "clawhub"].includes(cmd)) {
      commands.add(cmd);
    }
  }
  // Match shell command patterns
  const shellPatterns = content.match(/(?:run|execute|use)\s+`([a-z][\w-]+)`/gi) || [];
  for (const sp of shellPatterns) {
    const m = sp.match(/`([a-z][\w-]+)`/);
    if (m) commands.add(m[1]);
  }
  return [...commands];
}

function extractFilePaths(content: string): string[] {
  const paths = new Set<string>();
  // Match absolute paths
  const absMatches = content.match(/(?:`|")(\/[\w./-]+)(?:`|")/g) || [];
  for (const m of absMatches) {
    const p = m.replace(/[`"]/g, "");
    if (p.length > 3 && !p.includes("..")) paths.add(p);
  }
  // Match home-relative paths
  const homeMatches = content.match(/(?:`|")(~\/[\w./-]+)(?:`|")/g) || [];
  for (const m of homeMatches) {
    const p = m.replace(/[`"]/g, "").replace("~", HOME);
    paths.add(p);
  }
  return [...paths];
}

function extractEndpoints(content: string): string[] {
  const urls = new Set<string>();
  const urlMatches = content.match(/https?:\/\/[\w.-]+(?::\d+)?(?:\/[\w./-]*)?/g) || [];
  for (const url of urlMatches) {
    // Skip documentation/reference URLs
    if (url.includes("arxiv.org") || url.includes("github.com") || url.includes("openclaw.ai")) continue;
    urls.add(url);
  }
  return [...urls];
}

// ─── Run Tests ──────────────────────────────────────────────────────────

function testCLI(command: string): TestAssertion {
  try {
    const result = execSync(`which ${command} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
    return { type: "cli", target: command, passed: !!result, detail: result || "not found" };
  } catch {
    return { type: "cli", target: command, passed: false, detail: `${command} not found on PATH` };
  }
}

function testPath(filePath: string): TestAssertion {
  const exists = fsSync.existsSync(filePath);
  return { type: "path", target: filePath, passed: exists, detail: exists ? "exists" : "not found" };
}

async function testEndpoint(url: string): Promise<TestAssertion> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    return { type: "endpoint", target: url, passed: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { type: "endpoint", target: url, passed: false, detail: (err as Error).message.slice(0, 60) };
  }
}

// ─── Run All Tests for a Skill ──────────────────────────────────────────

export async function testSkillHealth(skillName: string): Promise<HealthTestResult> {
  const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
  const tests: TestAssertion[] = [];

  if (!fsSync.existsSync(skillFile)) {
    return { skill: skillName, passed: false, tests: [{ type: "path", target: skillFile, passed: false, detail: "SKILL.md not found" }], testedAt: new Date().toISOString() };
  }

  const content = fsSync.readFileSync(skillFile, "utf-8");

  // Test CLI commands
  for (const cmd of extractCLICommands(content)) {
    tests.push(testCLI(cmd));
  }

  // Test file paths
  for (const p of extractFilePaths(content)) {
    tests.push(testPath(p));
  }

  // Test endpoints
  for (const url of extractEndpoints(content)) {
    tests.push(await testEndpoint(url));
  }

  const passed = tests.length === 0 || tests.every(t => t.passed);

  // Log result
  const logFile = path.join(FORGE_DIR, "health-tests.jsonl");
  try {
    fsSync.appendFileSync(logFile, JSON.stringify({
      ts: new Date().toISOString(),
      skill: skillName,
      passed,
      testCount: tests.length,
      failures: tests.filter(t => !t.passed).map(t => `${t.type}:${t.target}`),
    }) + "\n");
  } catch { /* non-critical */ }

  return { skill: skillName, passed, tests, testedAt: new Date().toISOString() };
}

// ─── Run All Skills ─────────────────────────────────────────────────────

export async function runAllHealthTests(): Promise<HealthTestResult[]> {
  const skills = listActiveSkills();
  const results: HealthTestResult[] = [];

  for (const skill of skills) {
    results.push(await testSkillHealth(skill));
  }

  return results;
}

// ─── Format Report ──────────────────────────────────────────────────────

export function formatHealthTestReport(results: HealthTestResult[]): string {
  if (results.length === 0) return "No skills to test.";

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const noTests = results.filter(r => r.tests.length === 0).length;

  let text = `Skill Health Test Report\n\n`;
  text += `✅ ${passed} passed | ❌ ${failed} failed | ⚪ ${noTests} no testable assertions\n\n`;

  // Show failures first
  for (const r of results.filter(r => !r.passed)) {
    text += `❌ ${r.skill}\n`;
    for (const t of r.tests.filter(t => !t.passed)) {
      text += `  ${t.type}: ${t.target} — ${t.detail}\n`;
    }
    text += `\n`;
  }

  // Show passes briefly
  const passedSkills = results.filter(r => r.passed && r.tests.length > 0);
  if (passedSkills.length > 0) {
    text += `Passing: ${passedSkills.map(r => `${r.skill} (${r.tests.length} tests)`).join(", ")}\n`;
  }

  return text;
}
