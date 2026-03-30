/**
 * Skill validator — security-hardened SKILL.md validation
 *
 * v0.7.2 fixes:
 *   M6: Detect base64-encoded injection, homoglyph domains, env var exfil,
 *        multi-line split injection
 */
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";

const SKILLS_DIR = path.join(HOME, ".openclaw", "workspace", "skills");

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
    warnings.push("Frontmatter should use metadata.openclaw.category nesting");
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

  // M6 fix: Multi-line split injection detection
  // Reassemble adjacent lines and check for injection phrases
  // M6: skip multiline join on overlength skills (perf)
  const joinedLines = lines.length > 300 ? "" : skillMd.replace(/\n\d+\.\s*/g, " ").replace(/\n-\s*/g, " ");
  const splitInjectionPatterns = [
    /ignore\s+previous\s+instructions/i,
    /disregard\s+all\s+prior/i,
  ];
  for (const p of splitInjectionPatterns) {
    if (p.test(joinedLines) && !p.test(skillMd)) {
      // Only flag if caught in joined form but NOT already caught in original
      errors.push(`Split injection detected across lines: ${p.toString()}`);
    }
  }

  // P1: Credential patterns
  if (/password\s*[:=]\s*["'][^"']{8,}/i.test(skillMd) ||
      /api[_-]?key\s*[:=]\s*["'][^"']{16,}/i.test(skillMd) ||
      /token\s*[:=]\s*["'][^"']{16,}/i.test(skillMd)) {
    errors.push("Potential credential in plaintext");
  }

  // M6 fix: Base64-encoded payload detection
  if (/base64\s*(-d|--decode)?\s*\|\s*(sh|bash|exec|eval)/i.test(skillMd) ||
      /echo\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64/i.test(skillMd) ||
      /atob\s*\(\s*["'][A-Za-z0-9+/=]{16,}/i.test(skillMd)) {
    errors.push("Base64-encoded payload piped to shell or eval");
  }

  // M6 fix: Environment variable exfiltration
  if (/\$[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*/i.test(skillMd)) {
    const envExfilContext = /(?:curl|wget|fetch|http|url).*\$[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
    if (envExfilContext.test(skillMd)) {
      errors.push("Environment variable exfiltration pattern detected");
    } else {
      warnings.push("References environment variables containing secrets — review for exfiltration");
    }
  }


  // #7: Bare tilde path expansion (e.g., ~/.ssh/id_rsa without backticks)
  // Catches references to sensitive dotfiles that bypass the backtick path check
  const SENSITIVE_TILDE_PATHS = [
    /~\/\.ssh\b/i, /~\/\.gnupg\b/i, /~\/\.aws\b/i,
    /~\/\.kube\b/i, /~\/\.docker\b/i, /~\/\.npmrc\b/i,
    /~\/\.netrc\b/i, /~\/\.env\b/i,
  ];
  for (const pattern of SENSITIVE_TILDE_PATHS) {
    if (pattern.test(skillMd)) {
      const match = skillMd.match(pattern);
      warnings.push(`Bare tilde path to sensitive location: ${match ? match[0] : "~/"}`);
    }
  }

  // #8: Git credential helper token URLs (https://user:token@host)
  if (/https?:\/\/[^\s:]+:[A-Za-z0-9_\-]{16,}@/i.test(skillMd)) {
    errors.push("Git credential URL with embedded token detected");
  }

  // #9: Shell history file access (.bash_history, .zsh_history, etc.)
  if (/\.(?:bash_history|zsh_history|sh_history|bash_sessions|python_history)\b/i.test(skillMd)) {
    const historyContext = /(?:read|cat|head|tail|grep|less|more|open|exec|fs\.).*\.(?:bash_history|zsh_history|sh_history)/i;
    if (historyContext.test(skillMd)) {
      errors.push("Shell history file read detected — potential credential/command harvesting");
    } else {
      warnings.push("References shell history file — review for data harvesting intent");
    }
  }

  // #10: Telegram bot token pattern in skill content
  // Format: digits:alphanumeric (e.g., 123456789:ABCdefGHI_jklMNO-pqrSTU)
  if (/\b\d{8,10}:[A-Za-z0-9_\-]{35,}\b/.test(skillMd)) {
    errors.push("Telegram bot token pattern detected in skill content");
  }

  // P1: Path traversal — check code-like lines for workspace escapes
  const workspaceBase = path.join(HOME, ".openclaw", "workspace");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("---") || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const looksLikePath = /^\s*[-`~\/.]/.test(line) || /`[^`]*\.\.[^`]*`/.test(line);
    if (!looksLikePath) continue;
    if (line.includes("../") || line.includes("~")) {
      const cleanedPath = trimmed.replace(/[`'"]/g, "").trim();
      const resolved = path.resolve(workspaceBase, cleanedPath);
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
      const writeContext = /(?:write|append|modify|echo\s+.*>>?\s*.*(?:SOUL|MEMORY|IDENTITY)\.md|fs\.(?:write|append))/i;
      if (writeContext.test(skillMd)) {
        errors.push(`Skill attempts to write to ${mwp.name} — potential persistence attack`);
      } else {
        warnings.push(`Skill references ${mwp.name} — review for manipulation intent`);
      }
    }
  }

  // P1: Network domain allowlist + M6: homoglyph detection
  const networkPatterns = [
    /(?:https?:\/\/)([a-zA-Z0-9\u0400-\u04FF.-]+)/g,  // Extended to catch Cyrillic
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
    // M6 fix: Detect homoglyph/confusable characters in domain names
    // Check if domain contains non-ASCII characters that look like ASCII
    const hasNonAscii = /[^\x00-\x7F]/.test(domain);
    if (hasNonAscii) {
      errors.push(`Homoglyph/IDN domain detected: ${domain} — potential phishing`);
      continue;
    }

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
      if (ex.name === skillName) continue;
      // Skip dedup for revisions — a revision of "foo" is named "foo-rev-*"
      // and will naturally have high overlap with the parent skill
      if (skillName.startsWith(ex.name + "-rev-")) continue;
      if (ex.name.startsWith(skillName + "-rev-")) continue;
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

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const union = new Set([...setA, ...setB]);
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) intersection++; }
  const jaccard = intersection / union.size;

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

export { hybridSimilarity as jaccardSimilarity };
