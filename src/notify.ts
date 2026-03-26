import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

const HOME = os.homedir() || process.env.HOME || "";

const FORGE_DIR = path.join(
  HOME,
  ".openclaw",
  "workspace",
  ".forge"
);

interface NotifyConfig {
  channel: "telegram" | "slack" | "log";
  telegram?: { botToken: string; chatId: string };
  slack?: { webhookUrl: string };
}

function loadNotifyConfig(): NotifyConfig {
  const configPath = path.join(HOME, ".openclaw", "openclaw.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fsSync.readFileSync(configPath, "utf-8"));
  } catch {}

  const forcedChannel = process.env.ACEFORGE_NOTIFICATION_CHANNEL as
    | "telegram"
    | "slack"
    | "log"
    | undefined;

  const tg = (config as any)?.channels?.telegram;
  const tgToken = tg?.botToken || process.env.ACEFORGE_TELEGRAM_BOT_TOKEN || "";
  // NOTE: allowFrom contains authorized sender identifiers (e.g. phone numbers),
  // NOT Telegram chat_ids. Telegram chat_id comes from Message.chat.id.
  // Priority: ACEFORGE_OWNER_CHAT_ID env > config identityLinks > hardcoded fallback.
  const tgChatId =
    process.env.ACEFORGE_OWNER_CHAT_ID ||
    (config as any)?.session?.identityLinks?.sean?.find((l: string) => l.startsWith("telegram:"))?.split(":")[1] ||
    ""; // No hardcoded fallback — configure ACEFORGE_OWNER_CHAT_ID
  const telegramAvailable = !!(tgToken && tgChatId);

  const slackWebhook = process.env.ACEFORGE_SLACK_WEBHOOK_URL || "";
  const slackAvailable = !!slackWebhook;

  let channel: "telegram" | "slack" | "log" = "log";
  if (forcedChannel && ["telegram", "slack", "log"].includes(forcedChannel)) {
    channel = forcedChannel;
  } else if (telegramAvailable) {
    channel = "telegram";
  } else if (slackAvailable) {
    channel = "slack";
  }

  return {
    channel,
    telegram: telegramAvailable ? { botToken: tgToken, chatId: tgChatId } : undefined,
    slack: slackAvailable ? { webhookUrl: slackWebhook } : undefined,
  };
}

const notifyConfig = loadNotifyConfig();

async function sendTelegram(
  message: string,
  cfg: { botToken: string; chatId: string }
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: message }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Bug #15: Differentiate error types for actionable diagnostics
    if (res.status === 401) {
      throw new Error(`Telegram auth failed (401) — check ACEFORGE_TELEGRAM_BOT_TOKEN`);
    } else if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after") || "unknown";
      throw new Error(`Telegram rate limited (429) — retry after ${retryAfter}s`);
    } else if (res.status === 400) {
      throw new Error(`Telegram bad request (400) — check chat_id. Response: ${body.slice(0, 150)}`);
    } else {
      throw new Error(`Telegram API ${res.status}: ${body.slice(0, 150)}`);
    }
  }
  console.log(`[aceforge] Telegram sent: ${message.slice(0, 60)}`);
}

async function sendSlack(
  message: string,
  cfg: { webhookUrl: string }
): Promise<void> {
  const res = await fetch(cfg.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `[AceForge] ${message}` }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403 || res.status === 401) {
      throw new Error(`Slack auth failed (${res.status}) — check ACEFORGE_SLACK_WEBHOOK_URL`);
    } else if (res.status === 429) {
      throw new Error(`Slack rate limited (429) — too many notifications`);
    } else {
      throw new Error(`Slack webhook ${res.status}: ${body.slice(0, 150)}`);
    }
  }
  console.log(`[aceforge] Slack sent: ${message.slice(0, 60)}`);
}

function logToFile(message: string): void {
  const notifFile = path.join(FORGE_DIR, "notifications.jsonl");
  const entry =
    JSON.stringify({
      ts: new Date().toISOString(),
      type: "notification",
      message,
    }) + "\n";
  fsSync.appendFileSync(notifFile, entry);
  console.log(`[aceforge] Logged: ${message.slice(0, 60)}`);
}

// ─── Digest Mode ────────────────────────────────────────────────
// ACEFORGE_NOTIFY_DIGEST=true queues messages during analysis cycles
// and flushes them as a single combined message via flushDigest().
const DIGEST_ENABLED = process.env.ACEFORGE_NOTIFY_DIGEST === "true";
const digestQueue: string[] = [];

export async function notify(message: string): Promise<void> {
  // If digest mode is on, queue instead of sending immediately
  if (DIGEST_ENABLED) {
    digestQueue.push(message);
    logToFile(message); // always persist locally
    return;
  }

  try {
    if (notifyConfig.channel === "telegram" && notifyConfig.telegram) {
      await sendTelegram(message, notifyConfig.telegram);
    } else if (notifyConfig.channel === "slack" && notifyConfig.slack) {
      await sendSlack(message, notifyConfig.slack);
    } else {
      logToFile(message);
    }
  } catch (err) {
    console.error(`[aceforge] ${notifyConfig.channel} send failed, queuing:`, err);
    logToFile(message);
  }
}

/**
 * Flush queued digest notifications as a single combined message.
 * Call at the end of analyzePatterns() or agent_end cycle.
 * No-op if digest mode is off or queue is empty.
 */
export async function flushDigest(): Promise<void> {
  if (digestQueue.length === 0) return;

  const count = digestQueue.length;
  const combined = `AceForge Digest (${count} notification${count > 1 ? "s" : ""})\n` +
    `${"─".repeat(40)}\n` +
    digestQueue.join("\n─────\n");

  // Drain the queue before sending (prevents double-flush)
  digestQueue.length = 0;

  try {
    if (notifyConfig.channel === "telegram" && notifyConfig.telegram) {
      await sendTelegram(combined, notifyConfig.telegram);
    } else if (notifyConfig.channel === "slack" && notifyConfig.slack) {
      await sendSlack(combined, notifyConfig.slack);
    }
    console.log(`[aceforge] Digest flushed: ${count} notifications`);
  } catch (err) {
    console.error(`[aceforge] Digest flush failed:`, err);
    // Already logged individually via logToFile above
  }
}
