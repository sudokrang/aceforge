import { appendJsonl } from "./store.js";

const CORRECTION_PATTERNS = [
  "no, actually", "that's wrong", "not like that",
  "the right way is", "use x instead of y", "remember that",
  "from now on", "you're doing it wrong", "incorrect",
  "actually no", "I said", "retry that",
];

export function detectCorrectionPatterns(event: any): void {
  if (!event || !event.content || typeof event.content !== "string") return;

  const text = event.content;
  const lower = text.toLowerCase();

  for (const pattern of CORRECTION_PATTERNS) {
    if (lower.includes(pattern)) {
      const idx = lower.indexOf(pattern);
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + pattern.length + 80);
      const fragment = text.slice(start, end).replace(/\n/g, " ").trim();

      appendJsonl("patterns.jsonl", {
        ts: new Date().toISOString(),
        type: "correction",
        matched_phrase: pattern,
        text_fragment: fragment,
        from: event.from || "unknown",
        session: event.sessionKey || null,
      });

      console.log(`[aceforge] correction detected: "${pattern}"`);
      break;
    }
  }
}
