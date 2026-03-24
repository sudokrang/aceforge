/**
 * OpenViking context engine client (optional integration)
 *
 * Available for use when OpenViking is running alongside OpenClaw.
 * Not required for core AceForge functionality.
 *
 * Circuit breaker: 5s timeout, 3 failures → open for 10 min.
 * Import and call searchViking() from any module that needs Viking context.
 */
const VIKING_URL = process.env.ACEFORGE_VIKING_URL || "http://127.0.0.1:1933";
const TIMEOUT_MS = 5000;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 10 * 60 * 1000;

interface CircuitState {
  failures: number;
  lastFailure: number | null;
  isOpen: boolean;
}

const state: CircuitState = {
  failures: 0,
  lastFailure: null,
  isOpen: false,
};

function isCircuitOpen(): boolean {
  if (!state.isOpen) return false;
  if (state.lastFailure && Date.now() - state.lastFailure > CIRCUIT_RESET_MS) {
    state.isOpen = false;
    state.failures = 0;
    console.log("[aceforge/viking] circuit reset — auto-resuming");
    return false;
  }
  return true;
}

async function vikingQuery(query: string): Promise<unknown> {
  if (isCircuitOpen()) {
    throw new Error("Circuit breaker is OPEN — Viking queries suppressed for 10 min");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${VIKING_URL}/api/v1/search/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Viking ${res.status}`);
    const data = await res.json() as { status: string; result?: unknown };

    state.failures = 0;
    return data.result;
  } catch (err) {
    clearTimeout(timeout);
    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= FAILURE_THRESHOLD) {
      state.isOpen = true;
      console.error(`[aceforge/viking] CIRCUIT OPEN — ${state.failures} failures, suppressed for 10 min`);
    }
    throw err;
  }
}

export async function searchViking(query: string): Promise<unknown | null> {
  try {
    const result = await vikingQuery(query);
    return result ?? null;
  } catch (err) {
    console.error(`[aceforge/viking] query failed: ${(err as Error).message}`);
    return null;
  }
}

export async function checkDuplicatePatterns(pattern: string): Promise<boolean> {
  try {
    const result = await searchViking(pattern) as { memories?: unknown[]; skills?: unknown[] };
    if (!result) return false;
    const total = (result.memories?.length || 0) + (result.skills?.length || 0);
    return total > 0;
  } catch {
    return false;
  }
}

/** Check if OpenViking is reachable */
export async function checkVikingHealth(): Promise<{ available: boolean; url: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${VIKING_URL}/api/v1/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { available: res.ok, url: VIKING_URL };
  } catch {
    return { available: false, url: VIKING_URL };
  }
}
