import * as fsSync from "fs";
import * as path from "path";

const FORGE_DIR = path.join(
  process.env.HOME || "~",
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
  const configPath = path.join(process.env.HOME || "~", ".openclaw", "openclaw.json");
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
  const tgChatId = tg?.allowFrom?.[0] || process.env.ACEFORGE_OWNER_CHAT_ID || "";
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
  if (!res.ok) throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
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

export async function notify(message: string): Promise<void> {
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
