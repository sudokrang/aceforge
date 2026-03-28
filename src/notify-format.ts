/**
 * Notification Formatting — Channel-Agnostic with Tiered Rendering
 *
 * Tier 1 (Plain): Unicode + emoji + whitespace. Works on ALL channels.
 *   WhatsApp, Signal, iMessage, IRC, Matrix, Nostr, WeChat, LINE, etc.
 *
 * Tier 2 (Rich): Adds native formatting for channels that render it.
 *   Telegram → HTML (<b>, <code>, <i>)
 *   Slack → mrkdwn (*bold*, `code`)
 *
 * Design principles:
 *   - Plain text is the PRIMARY target, not a fallback
 *   - Rich formatting is a polish layer, never required for readability
 *   - Monospace commands = tap-to-copy on Telegram, visual distinction on Slack
 *   - Consistent emoji vocabulary across all notification types
 *   - Mobile-first: scan in 2 seconds on a phone lock screen
 */
import * as os from "os";
import * as path from "path";
import * as fsSync from "fs";

// ─── Channel Detection ──────────────────────────────────────────────────

export type NotifyChannel = "telegram" | "slack" | "log" | "plain";

let _detected: NotifyChannel | null = null;

export function detectChannel(): NotifyChannel {
  if (_detected) return _detected;

  const HOME = os.homedir() || process.env.HOME || "";
  const forced = process.env.ACEFORGE_NOTIFICATION_CHANNEL;
  if (forced && ["telegram", "slack", "log"].includes(forced)) {
    _detected = forced as NotifyChannel;
    return _detected;
  }

  // Read from openclaw.json — same logic as notify.ts
  try {
    const cfgPath = path.join(HOME, ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fsSync.readFileSync(cfgPath, "utf-8"));
    const tg = cfg?.channels?.telegram;
    const tgToken = tg?.botToken || process.env.ACEFORGE_TELEGRAM_BOT_TOKEN || "";
    const tgChatId = process.env.ACEFORGE_OWNER_CHAT_ID || "";
    if (tgToken && tgChatId) { _detected = "telegram"; return "telegram"; }
  } catch { /* no config */ }

  if (process.env.ACEFORGE_TELEGRAM_BOT_TOKEN && process.env.ACEFORGE_OWNER_CHAT_ID) {
    _detected = "telegram"; return "telegram";
  }
  if (process.env.ACEFORGE_SLACK_WEBHOOK_URL) {
    _detected = "slack"; return "slack";
  }

  _detected = "plain";
  return "plain";
}

// ─── Formatting Primitives ──────────────────────────────────────────────
// Each returns the same logical content, rendered for the active channel.

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Bold text — titles, labels, emphasis */
export function bold(text: string): string {
  const ch = detectChannel();
  if (ch === "telegram") return `<b>${escHtml(text)}</b>`;
  if (ch === "slack") return `*${text}*`;
  return text;
}

/** Italic text — descriptions, subtitles */
export function italic(text: string): string {
  const ch = detectChannel();
  if (ch === "telegram") return `<i>${escHtml(text)}</i>`;
  if (ch === "slack") return `_${text}_`;
  return text;
}

/** Monospace — commands (tap-to-copy on Telegram), tool names */
export function mono(text: string): string {
  const ch = detectChannel();
  if (ch === "telegram") return `<code>${escHtml(text)}</code>`;
  if (ch === "slack") return `\`${text}\``;
  return text;
}

/** Format a key-value metric pair: "Label  value" with bold label on rich */
export function metric(label: string, value: string | number): string {
  return `${bold(label)}  ${value}`;
}

/** Format action commands — each on its own line for easy copy */
export function actions(...commands: string[]): string {
  return commands.map(c => mono(c)).join("\n");
}

/** Join non-empty parts with blank line separators */
export function compose(...blocks: (string | null | undefined | false)[]): string {
  return blocks.filter(Boolean).join("\n\n");
}
