/**
 * Heartbeat module for OpenClaw Cloud.
 *
 * Sends heartbeat every 30 seconds to keep the instance alive.
 * Without this, DO manager will auto-suspend the machine after 5 minutes of inactivity.
 *
 * Similar to token-refresh.ts but:
 * - Interval: 30 seconds (vs 50 minutes for token refresh)
 * - Purpose: Keep machine from being suspended (vs refresh JWT token)
 */

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let isCloudEnvironment: boolean | null = null;

/**
 * Detect cloud environment by checking if /_heartbeat endpoint exists.
 * In standalone OpenClaw Gateway (non-cloud), this endpoint doesn't exist.
 */
async function detectCloudEnvironment(): Promise<boolean> {
  if (isCloudEnvironment !== null) {
    return isCloudEnvironment;
  }

  try {
    // POST to /_heartbeat - 404 means standalone mode
    const res = await fetch("/_heartbeat", { method: "POST", credentials: "include" });
    // Any status other than 404 means endpoint exists = cloud mode
    isCloudEnvironment = res.status !== 404;
  } catch {
    // Network error - assume standalone mode
    isCloudEnvironment = false;
  }

  return isCloudEnvironment;
}

/**
 * Send heartbeat to keep instance alive.
 */
async function sendHeartbeat(): Promise<boolean> {
  try {
    const res = await fetch("/_heartbeat", { method: "POST", credentials: "include" });

    if (res.status === 404) {
      // Endpoint doesn't exist - we're in standalone mode
      return true;
    }

    if (res.ok) {
      console.log("[heartbeat] Ping successful");
      return true;
    }

    console.warn("[heartbeat] Ping failed:", res.status);
    return false;
  } catch (err) {
    console.error("[heartbeat] Error:", err);
    return false;
  }
}

/**
 * Start heartbeat polling (30 second interval).
 * Detects cloud environment first, only runs in cloud mode.
 */
export async function startHeartbeat(): Promise<void> {
  if (heartbeatInterval) {
    return; // Already running
  }

  const isCloud = await detectCloudEnvironment();
  if (!isCloud) {
    console.log("[heartbeat] Standalone mode detected, heartbeat disabled");
    return;
  }

  console.log("[heartbeat] Cloud mode detected, starting heartbeat (30s interval)");

  // Initial heartbeat immediately
  await sendHeartbeat();

  // Then every 30 seconds
  heartbeatInterval = setInterval(() => {
    void sendHeartbeat();
  }, 30 * 1000);
}

/**
 * Stop heartbeat polling.
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log("[heartbeat] Heartbeat stopped");
  }
}
