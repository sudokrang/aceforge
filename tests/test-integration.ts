/**
 * AceForge Integration Test
 *
 * Proves the full pipeline connects: synthetic traces → pattern analysis
 * → candidate detection → template generation → proposal written to disk.
 *
 * No LLM API keys needed — exercises template fallback path.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";
const FORGE_DIR = path.join(HOME, ".openclaw", "workspace", ".forge");
const PROPOSALS_DIR = path.join(FORGE_DIR, "proposals");
const PATTERNS_FILE = path.join(FORGE_DIR, "patterns.jsonl");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function section(name: string): void {
  console.log(`\n═══ ${name} ═══`);
}

// ─── Setup: clean slate ─────────────────────────────────────────────

section("Setup");

// Backup existing patterns if any
const backupFile = PATTERNS_FILE + ".integration-backup";
const hadExistingPatterns = fs.existsSync(PATTERNS_FILE);
if (hadExistingPatterns) {
  fs.copyFileSync(PATTERNS_FILE, backupFile);
  console.log("  Backed up existing patterns.jsonl");
}

// Backup existing proposals
const proposalsBefore = fs.existsSync(PROPOSALS_DIR)
  ? fs.readdirSync(PROPOSALS_DIR) : [];

// ─── Stage 1: Write synthetic traces ────────────────────────────────

section("Stage 1: Inject Synthetic Traces");

const SYNTHETIC_TOOL = "integration-test-tool";
const now = new Date();
const traces: string[] = [];

// Generate 5 successful traces across 3 sessions and 2 days
for (let i = 0; i < 5; i++) {
  const ts = new Date(now.getTime() - (i * 3600 * 1000));
  const trace = JSON.stringify({
    type: "trace",
    tool: SYNTHETIC_TOOL,
    ts: ts.toISOString(),
    args_summary: `integration test arg set ${i}`,
    result_summary: `success result ${i}`,
    success: true,
    session: `integration-session-${i % 3}`,
    duration_ms: 100 + i * 50,
  });
  traces.push(trace);
}

// Add 1 failure trace
traces.push(JSON.stringify({
  type: "trace",
  tool: SYNTHETIC_TOOL,
  ts: new Date(now.getTime() - 7200000).toISOString(),
  args_summary: "integration test failure case",
  result_summary: null,
  success: false,
  error: "simulated failure for integration test",
  session: "integration-session-fail",
  duration_ms: 50,
}));

// Append to patterns file
fs.mkdirSync(FORGE_DIR, { recursive: true });
fs.appendFileSync(PATTERNS_FILE, traces.join("\n") + "\n");

assert(fs.existsSync(PATTERNS_FILE), "patterns.jsonl exists after trace injection");

const content = fs.readFileSync(PATTERNS_FILE, "utf-8");
const injectedCount = content.split("\n").filter(l => l.includes(SYNTHETIC_TOOL)).length;
assert(injectedCount >= 6, `Found ${injectedCount} synthetic traces in patterns.jsonl (expected ≥6)`);

// ─── Stage 2: Run pattern analysis ──────────────────────────────────

section("Stage 2: Run Pattern Analysis (template fallback)");

// Unset LLM keys to force template fallback
const savedGenKey = process.env.ACEFORGE_GENERATOR_API_KEY;
const savedRevKey = process.env.ACEFORGE_REVIEWER_API_KEY;
delete process.env.ACEFORGE_GENERATOR_API_KEY;
delete process.env.ACEFORGE_REVIEWER_API_KEY;

try {
  const { analyzePatterns } = await import("../src/pattern/analyze.js");
  await analyzePatterns();
  assert(true, "analyzePatterns() completed without throwing");
} catch (err) {
  assert(false, `analyzePatterns() threw: ${(err as Error).message}`);
}

// Restore keys
if (savedGenKey) process.env.ACEFORGE_GENERATOR_API_KEY = savedGenKey;
if (savedRevKey) process.env.ACEFORGE_REVIEWER_API_KEY = savedRevKey;

// ─── Stage 3: Verify proposal was generated ─────────────────────────

section("Stage 3: Verify Proposal Output");

const proposalsAfter = fs.existsSync(PROPOSALS_DIR)
  ? fs.readdirSync(PROPOSALS_DIR) : [];
const newProposals = proposalsAfter.filter(p => !proposalsBefore.includes(p));
const ourProposal = newProposals.find(p =>
  p.includes(SYNTHETIC_TOOL) || p.includes("integration")
);

assert(newProposals.length > 0, `New proposal(s) generated: ${newProposals.join(", ") || "none"}`);

if (ourProposal) {
  const skillMdPath = path.join(PROPOSALS_DIR, ourProposal, "SKILL.md");
  assert(fs.existsSync(skillMdPath), `SKILL.md exists at ${ourProposal}/SKILL.md`);

  if (fs.existsSync(skillMdPath)) {
    const skillMd = fs.readFileSync(skillMdPath, "utf-8");

    // Verify structural requirements
    assert(skillMd.includes("name:"), "SKILL.md has name field");
    assert(skillMd.includes("description:"), "SKILL.md has description field");
    assert(skillMd.includes("metadata:"), "SKILL.md has metadata block");
    assert(skillMd.includes("openclaw:"), "SKILL.md has openclaw metadata");
    assert(skillMd.includes("category:"), "SKILL.md has category field");
    assert(skillMd.includes("aceforge:"), "SKILL.md has aceforge metadata");
    assert(skillMd.includes("status: proposed"), "SKILL.md status is proposed");
    assert(skillMd.includes("## ") || skillMd.includes("# "), "SKILL.md has markdown headings");

    // Verify it would pass the validator
    try {
      const { validateSkillMd } = await import("../src/skill/validator.js");
      const valResult = validateSkillMd(skillMd, ourProposal);
      assert(valResult.valid || valResult.errors.length === 0,
        `Generated SKILL.md passes validator (errors: ${valResult.errors.join("; ") || "none"})`);
    } catch (err) {
      assert(false, `Validator failed to load: ${(err as Error).message}`);
    }
  }
} else {
  // Might have been filtered — check filtered-candidates.jsonl
  const filteredFile = path.join(FORGE_DIR, "filtered-candidates.jsonl");
  if (fs.existsSync(filteredFile)) {
    const filtered = fs.readFileSync(filteredFile, "utf-8");
    const ourFiltered = filtered.split("\n").filter(l => l.includes(SYNTHETIC_TOOL));
    if (ourFiltered.length > 0) {
      console.log(`  ℹ️  Tool was filtered: ${ourFiltered[0].slice(0, 120)}`);
      assert(true, "Tool was intentionally filtered by quality gates (pipeline still connected)");
    }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────

section("Cleanup");

// Remove synthetic traces from patterns.jsonl
if (hadExistingPatterns) {
  fs.copyFileSync(backupFile, PATTERNS_FILE);
  fs.unlinkSync(backupFile);
  console.log("  Restored original patterns.jsonl");
} else {
  // Remove only our synthetic lines
  const lines = fs.readFileSync(PATTERNS_FILE, "utf-8").split("\n");
  const cleaned = lines.filter(l => !l.includes(SYNTHETIC_TOOL));
  fs.writeFileSync(PATTERNS_FILE, cleaned.join("\n"));
  console.log("  Removed synthetic traces from patterns.jsonl");
}

// Remove our test proposal if generated
if (ourProposal) {
  const proposalDir = path.join(PROPOSALS_DIR, ourProposal);
  if (fs.existsSync(proposalDir)) {
    fs.rmSync(proposalDir, { recursive: true, force: true });
    console.log(`  Removed test proposal: ${ourProposal}`);
  }
}

// ─── Results ────────────────────────────────────────────────────────

section("Results");
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}\n`);

if (failed > 0) {
  console.error("INTEGRATION TEST FAILED");
  process.exit(1);
} else {
  console.log("INTEGRATION TEST PASSED ✅");
}
