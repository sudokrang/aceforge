/**
 * Skill validator — security-hardened SKILL.md validation
 *
 * v0.6.0 fixes:
 *  - M5: similarity uses Jaccard+bigram hybrid (was degenerate TF-IDF with N=2)
 *  - G1: detects SOUL.md/MEMORY.md write patterns (ClawHavoc attack vector)
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ─── H8-fix: Use os.homedir() instead of process.env.HOME || "~"
const HOME = os.homedir() || process.env.HOME || "";

const SKILLS_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "skills"
);

const ALLOWED_NET_DOMAINS = new Set([
  "api.telegram.org",
  "api.openai.com",
  "api.anthropic.com",
  "api.minimax.io",
  "api.minimax.chat",
  "moonshot.cn",
  "api.moonshot.cn",
  "api.cohere.com",
  "api.deepseek.com",
  "openrouter.ai",
  "localhost",
  "127.0.0.1",
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSkillMd(skillMd: string, skillName: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required frontmatter fields
  const lines = skillMd.split("\n");
  const hasName = lines.some(l => l.trim().startsWith("name:"));
  const hasDesc = lines.some(l => l.trim().startsWith("description:"));

  if (!hasName) errors.push("Missing 'name' in frontmatter");
  if (!hasDesc) errors.push("Missing 'description' in frontmatter");

  // Nested metadata structure
  if (!skillMd.includes("metadata:") || !skillMd.includes("openclaw:") || !skillMd.includes("category:")) {
    errors.push("Frontmatter must use metadata.openclaw.category nesting");
  }

  // P1: Injection patterns
  const injectionPatterns = [
    /ignore\s+previous\s+instructions/i,
    /you\s+are\s+now\s+[^.!?]+$/im,
    /disregard\s+all\s+prior/i,
    /forget\s+everything/i,
  ];
  for (const p of injectionPatterns) {
    if (p.test(skillMd)) {
      errors.push(`Injection pattern detected: ${p.toString()}`);
    }
  }

  // P1: Credential patterns
  if (/password\s*[:=]\s*["'][^"']{8,}/i.test(skillMd) ||
      /api[_-]?key\s*[:=]\s*["'][^"']{16,}/i.test(skillMd) ||
      /token\s*[:=]\s*["'][^"']{16,}/i.test(skillMd)) {
    errors.push("Potential credential in plaintext");
  }

  // P1: Path traversal — check code-like lines for workspace escapes
  const workspaceBase = path.join(HOME, ".openclaw", "workspace");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("---") || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const looksLikePath = /^\s*[-`~\/.]/.test(line) || /`[^`]*\.\.[^`]*`/.test(line);
    if (!looksLikePath) continue;
    if (line.includes("../") || line.includes("~")) {
      const resolved = path.resolve(workspaceBase, trimmed);
      if (!resolved.startsWith(workspaceBase)) {
        errors.push(`Path traversal attempt detected: ${trimmed.slice(0, 50)}`);
      }
    }
  }

  // G1: SOUL.md / MEMORY.md / IDENTITY.md manipulation detection (ClawHavoc vector)
  const memoryWritePatterns = [
    { pattern: /SOUL\.md/i, name: "SOUL.md" },
    { pattern: /MEMORY\.md/i, name: "MEMORY.md" },
    { pattern: /IDENTITY\.md/i, name: "IDENTITY.md" },
  ];
  for (const mwp of memoryWritePatterns) {
    if (mwp.pattern.test(skillMd)) {
      // Check if it's in a code block or instruction context suggesting write
      const writeContext = /(?:write|append|modify|echo\s+.*>>?\s*.*(?:SOUL|MEMORY|IDENTITY)\.md|fs\.(?:write|append))/i;
      if (writeContext.test(skillMd)) {
        errors.push(`Skill attempts to write to ${mwp.name} — potential persistence attack`);
      } else {
        warnings.push(`Skill references ${mwp.name} — review for manipulation intent`);
      }
    }
  }

  // P1: Network domain allowlist
  const networkPatterns = [
    /(?:https?:\/\/)([a-zA-Z0-9.-]+)/g,
    /curl\s+["'](https?:\/\/[^"']+)/gi,
    /wget\s+["'](https?:\/\/[^"']+)/gi,
  ];
  const foundDomains = new Set<string>();
  for (const re of networkPatterns) {
    let m;
    while ((m = re.exec(skillMd)) !== null) {
      foundDomains.add(m[1]);
    }
  }
  for (const domain of foundDomains) {
    if (!ALLOWED_NET_DOMAINS.has(domain) && !domain.endsWith(".local")) {
      warnings.push(`Unrecognized network domain: ${domain}`);
    }
  }

  // Length check
  if (lines.length > 500) {
    errors.push(`SKILL.md exceeds 500 lines (${lines.length})`);
  }

  // Description similarity against existing skills (M5 fix: improved similarity)
  const descMatch = skillMd.match(/^\s*description:\s*(.+)/m);
  if (descMatch) {
    const existing = listExistingSkills();
    for (const ex of existing) {
      if (ex.name === skillName) continue; // Don't compare against self
      const similarity = hybridSimilarity(descMatch[1], ex.desc);
      if (similarity >= 0.95) {
        errors.push(
          `BLOCKED: Duplicate of existing skill '${ex.name}' ` +
          `(${Math.round(similarity * 100)}% overlap)`
        );
      } else if (similarity > 0.8) {
        errors.push(
          `Too similar to existing skill '${ex.name}' ` +
          `(${Math.round(similarity * 100)}% overlap)`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

interface ExistingSkill {
  name: string;
  desc: string;
}

function listExistingSkills(): ExistingSkill[] {
  if (!fsSync.existsSync(SKILLS_DIR)) return [];
  const skills: ExistingSkill[] = [];
  for (const dir of fsSync.readdirSync(SKILLS_DIR)) {
    const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
    if (!fsSync.existsSync(skillFile)) continue;
    try {
      const content = fsSync.readFileSync(skillFile, "utf-8");
      const descMatch = content.match(/^\s*description:\s*(.+)/m);
      skills.push({ name: dir, desc: descMatch?.[1] || "" });
    } catch { /* skip unreadable */ }
  }
  return skills;
}

/**
 * M5 fix: Hybrid Jaccard + bigram similarity
 * Replaces the degenerate TF-IDF that only computed IDF from 2 documents.
 * Stop-word filtering + bigram sequence overlap catches near-duplicates properly.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "are", "was", "has",
  "use", "using", "when", "tool", "skill", "auto", "based", "data",
]);

function tokenizeClean(s: string): string[] {
  return s.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function hybridSimilarity(a: string, b: string): number {
  const tokensA = tokenizeClean(a);
  const tokensB = tokenizeClean(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Unigram Jaccard
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const union = new Set([...setA, ...setB]);
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) intersection++; }
  const jaccard = intersection / union.size;

  // Bigram Jaccard (catches sequence similarity)
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < tokensA.length - 1; i++) bigramsA.add(tokensA[i] + " " + tokensA[i + 1]);
  for (let i = 0; i < tokensB.length - 1; i++) bigramsB.add(tokensB[i] + " " + tokensB[i + 1]);
  let bigramIntersection = 0;
  for (const bg of bigramsA) { if (bigramsB.has(bg)) bigramIntersection++; }
  const bigramUnion = new Set([...bigramsA, ...bigramsB]).size;
  const bigramScore = bigramUnion > 0 ? bigramIntersection / bigramUnion : 0;

  return 0.6 * jaccard + 0.4 * bigramScore;
}

// Backward-compatible export name
export { hybridSimilarity as jaccardSimilarity };
