/**
 * Pattern store — JSONL with rotation (10K lines, 30 days, gzip)
 *
 * v0.6.0 fix: M1 — rotation is now synchronous with a guard flag
 * to prevent data loss from concurrent append during async gzip.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as fsSync from "fs";
import * as os from "os";
import { execSync } from "child_process";

const HOME = os.homedir() || process.env.HOME || "";

const FORGE_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  ".forge"
);
const MAX_LINES = 10000;
const MAX_AGE_DAYS = 30;

let rotating = false;

function rotateFile(fileName: string): void {
  if (rotating) return;

  const filePath = path.join(FORGE_DIR, fileName);
  if (!fsSync.existsSync(filePath)) return;

  let lines: string[];
  try {
    const content = fsSync.readFileSync(filePath, "utf-8").trim();
    if (!content) return;
    lines = content.split("\n").filter(Boolean);
  } catch { return; }

  const stats = fsSync.statSync(filePath);
  const shouldRotate = lines.length >= MAX_LINES ||
    (Date.now() - stats.mtimeMs > MAX_AGE_DAYS * 24 * 60 * 60 * 1000 && lines.length > 100);

  if (!shouldRotate) return;

  rotating = true;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = fileName.replace(".jsonl", "");
    const archivePath = path.join(FORGE_DIR, `${baseName}-${stamp}.jsonl.gz`);

    execSync(`gzip -c "${filePath}" > "${archivePath}" && : > "${filePath}"`, {
      timeout: 15000,
      stdio: "pipe",
    });
    console.log(`[aceforge] rotated ${fileName} → ${baseName}-${stamp}.jsonl.gz (${lines.length} lines)`);
  } catch (err) {
    console.error(`[aceforge] rotation failed for ${fileName}: ${(err as Error).message}`);
  } finally {
    rotating = false;
  }
}

export function ensureForgeDir(): void {
  const subDirs = ["proposals", "retired"];
  for (const d of subDirs) {
    const dir = path.join(FORGE_DIR, d);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
  }
  const files = ["patterns.jsonl", "skill-health.jsonl", "notifications.jsonl", "candidates.jsonl"];
  for (const f of files) {
    const filePath = path.join(FORGE_DIR, f);
    if (!fsSync.existsSync(filePath)) {
      fsSync.writeFileSync(filePath, "", "utf-8");
    }
  }
}

export function appendJsonl(fileName: string, record: Record<string, unknown>): void {
  const filePath = path.join(FORGE_DIR, fileName);
  fsSync.appendFileSync(filePath, JSON.stringify(record) + "\n");
  // Non-blocking rotation check (synchronous inside, but guarded)
  rotateFile(fileName);
}

export async function appendPattern(pattern: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ...pattern, ts: new Date().toISOString() }) + "\n";
  await fs.appendFile(path.join(FORGE_DIR, "patterns.jsonl"), line, "utf-8");
}

export async function readPatterns(): Promise<Record<string, unknown>[]> {
  const filePath = path.join(FORGE_DIR, "patterns.jsonl");
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as Record<string, unknown>[];
}

export async function appendNotification(notification: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ...notification, ts: new Date().toISOString() }) + "\n";
  await fs.appendFile(path.join(FORGE_DIR, "notifications.jsonl"), line, "utf-8");
}
