/**
 * Skill index — metadata-only context injection via before_prompt_build
 *
 * v0.6.0 fix: G9 — token estimation uses word count * 1.3 instead of chars / 4
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";

const SKILLS_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  "skills"
);

export function buildHierarchicalSkillIndex(): string | undefined {
  if (!fs.existsSync(SKILLS_DIR)) return undefined;

  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(SKILLS_DIR);
  } catch {
    return undefined;
  }

  const categories: Record<string, string[]> = {
    OPERATIONS: [], MONITORING: [], COMMUNICATION: [],
    INFRASTRUCTURE: [], DEVELOPMENT: [], ANALYSIS: []
  };

  for (const dir of dirs) {
    const skillPath = path.join(SKILLS_DIR, dir);
    try {
      if (!fs.statSync(skillPath).isDirectory()) continue;
    } catch { continue; }

    const skillFile = path.join(skillPath, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    try {
      const content = fs.readFileSync(skillFile, "utf-8");
      let cat: string;

      const nestedMatch = content.match(/^\s*metadata:\s*\n\s+openclaw:\s*\n\s+category:\s*(\w+)/mi);
      if (nestedMatch) {
        cat = nestedMatch[1].toUpperCase();
      } else {
        const flatMatch = content.match(/^\s*category:\s*(\w+)/mi);
        cat = flatMatch ? flatMatch[1].toUpperCase() : "ANALYSIS";
      }

      if (["OPS", "OPERATIONS"].includes(cat)) cat = "OPERATIONS";
      else if (["MONITOR", "MONITORING"].includes(cat)) cat = "MONITORING";
      else if (["COMMS", "COMMUNICATION"].includes(cat)) cat = "COMMUNICATION";
      else if (["INFRA", "INFRASTRUCTURE"].includes(cat)) cat = "INFRASTRUCTURE";
      else if (["DEV", "DEVELOPMENT"].includes(cat)) cat = "DEVELOPMENT";
      else if (["WORKFLOW"].includes(cat)) cat = "OPERATIONS";
      else if (["REMEDIATION"].includes(cat)) cat = "OPERATIONS";
      else cat = "ANALYSIS";

      categories[cat].push(dir);
    } catch {
      categories.ANALYSIS.push(dir);
    }
  }

  let output = "[AceForge Skills — read full SKILL.md with the read tool when needed]\n";
  let hasSkills = false;

  for (const [cat, skillNames] of Object.entries(categories)) {
    if (skillNames.length === 0) continue;
    output += `\n${cat}:\n`;
    for (const name of skillNames) {
      const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
      let description = "";
      let category = "general";
      try {
        const content = fs.readFileSync(skillFile, "utf-8");
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?$/m);
        description = descMatch ? descMatch[1].slice(0, 120) : "";
        const catNested = content.match(/^\s*metadata:\s*\n\s+openclaw:\s*\n\s+category:\s*(\w+)/mi);
        const catFlat = content.match(/^\s*category:\s*(\w+)/mi);
        if (catNested) category = catNested[1];
        else if (catFlat) category = catFlat[1];
      } catch {}
      const location = skillFile;
      output += `  - [${category}] ${name}: ${description}`;
      output += ` [${location}]\n`;
      hasSkills = true;
    }
  }

  if (!hasSkills) return undefined;
  output += "\nTo use a skill: read its SKILL.md file for full instructions before proceeding.";

  // G9 fix: better token estimation — word count * 1.3 is closer to real tokenization
  const MAX_TOKENS = 3000;
  const estimatedTokens = Math.ceil(output.split(/\s+/).length * 1.3);
  if (estimatedTokens > MAX_TOKENS) {
    const targetWords = Math.floor(MAX_TOKENS / 1.3);
    const words = output.split(/\s+/);
    output = words.slice(0, targetWords).join(" ") +
      "\n[AceForge: skill index truncated — " + estimatedTokens + " est. tokens exceeded " + MAX_TOKENS + " budget]";
  }

  return output;
}
