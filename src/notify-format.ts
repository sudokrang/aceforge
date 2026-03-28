/**
 * Notification Formatting — Channel-Agnostic with Tiered Rendering
 *
 * Tier 1 (Plain): Unicode + emoji + whitespace. Works on ALL channels.
 *   WhatsApp, Signal, iMessage, IRC, Matrix, Nostr, WeChat, LINE, etc.
 *
 * Tier 2 (Rich): Adds native formatting based on FORMAT TYPE, not channel name.
 *   html     → Telegram, email, any HTML-rendering channel
 *   markdown → Discord, Matrix, IRC (most modern chat platforms)
 *   mrkdwn   → Slack (single * for bold, _ for italic)
 *   plain    → everything else (Tier 1 only)
 *
 * Adding a new channel: map it to a format type in FORMAT_MAP below.
 * Never touch the primitives — they work on format types, not channels.
 *
 * Design principles:
 *   - Plain text is the PRIMARY target, not a fallback
 *   - Rich formatting is a polish layer, never required for readability
 *   - Monospace commands = tap-to-copy on Telegram, visual distinction elsewhere
 *   - Consistent emoji vocabulary across all notification types
 *   - Mobile-first: scan in 2 seconds on a phone lock screen
 */
import { getNotifyChannel } from "./notify.js";

// ─── Format Types ───────────────────────────────────────────────────────
// The formatting primitives operate on these — never on channel names.

export type FormatType = "html" | "markdown" | "mrkdwn" | "plain";

/**
 * Map transport channel → format type.
 * This is the ONLY place channel names appear in the formatting layer.
 * Adding a new channel: one line here. Zero changes to bold/mono/italic.
 */
const FORMAT_MAP: Record<string, FormatType> = {
  telegram: "html",
  slack:    "mrkdwn",
  discord:  "markdown",
  matrix:   "markdown",
  irc:      "plain",
  log:      "plain",
};

// Channel type — exported for type consumers. Formatting primitives use FormatType internally.
export type NotifyChannel = "telegram" | "slack" | "discord" | "log" | "plain";

let _format: FormatType | null = null;

export function detectChannel(): NotifyChannel {
  // Legacy: returns channel name for any code that still needs it
  const ch = getNotifyChannel();
  return ch === "log" ? "plain" : ch as NotifyChannel;
}

function getFormat(): FormatType {
  if (_format) return _format;
  const ch = getNotifyChannel();
  _format = FORMAT_MAP[ch] || "plain";
  return _format;
}

// ─── HTML Escaping (for html format only) ───────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Formatting Primitives ──────────────────────────────────────────────
// Each operates on FORMAT TYPE. Adding a channel never touches these.

/** Bold text — titles, labels, emphasis */
export function bold(text: string): string {
  const fmt = getFormat();
  if (fmt === "html") return `<b>${escHtml(text)}</b>`;
  if (fmt === "mrkdwn") return `*${text}*`;
  if (fmt === "markdown") return `**${text}**`;
  return text;
}

/** Italic text — descriptions, subtitles */
export function italic(text: string): string {
  const fmt = getFormat();
  if (fmt === "html") return `<i>${escHtml(text)}</i>`;
  if (fmt === "mrkdwn") return `_${text}_`;
  if (fmt === "markdown") return `*${text}*`;
  return text;
}

/** Monospace — commands (tap-to-copy on Telegram), tool names */
export function mono(text: string): string {
  const fmt = getFormat();
  if (fmt === "html") return `<code>${escHtml(text)}</code>`;
  if (fmt === "mrkdwn") return `\`${text}\``;
  if (fmt === "markdown") return `\`${text}\``;
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
