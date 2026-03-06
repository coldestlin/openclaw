/**
 * Token refresh module for OpenClaw Cloud authentication.
 *
 * When running under OpenClaw Cloud (via claw-xxx.openclaw.ski subdomain),
 * the user's JWT token has a 1-hour expiry. This module periodically calls
 * the Gateway's /_refresh endpoint to renew the token, enabling users to
 * stay logged in indefinitely even if they only have the Instance page open.
 *
 * The /_refresh endpoint:
 * - Reads oc_refresh_token cookie (HttpOnly)
 * - Calls Supabase to get new access_token and refresh_token
 * - Updates both cookies
 *
 * Multi-tab/Multi-subdomain handling:
 * - Random jitter is added to refresh interval to reduce collision probability
 * - If refresh fails with "already_used", we retry once (another tab may have refreshed)
 */

let tokenRefreshInterval: ReturnType<typeof setInterval> | null = null;
let isCloudEnvironment: boolean | null = null;

// Configuration
const BASE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes base interval
const RANDOM_JITTER_MS = 5 * 60 * 1000; // ±5 minutes random jitter
const RETRY_DELAY_MS = 2000; // 2 seconds wait before retry

/**
 * Check if we're running under OpenClaw Cloud by looking for the /_refresh endpoint.
 * In standalone OpenClaw Gateway (non-cloud), this endpoint doesn't exist.
 */
async function detectCloudEnvironment(): Promise<boolean> {
  if (isCloudEnvironment !== null) {
    return isCloudEnvironment;
  }

  try {
    // Try to call /_refresh - if it returns anything other than 404, we're in cloud mode
    const res = await fetch("/_refresh", { method: "POST", credentials: "include" });
    // 401 (no refresh token) or 200 (success) means endpoint exists = cloud mode
    // 404 means endpoint doesn't exist = standalone mode
    isCloudEnvironment = res.status !== 404;
  } catch {
    // Network error - assume standalone mode
    isCloudEnvironment = false;
  }

  return isCloudEnvironment;
}

/**
 * Refresh the authentication token by calling Gateway's /_refresh endpoint.
 * Returns true if refresh was successful or unnecessary (standalone mode).
 *
 * Includes retry logic for "refresh_token_already_used" errors, which can occur
 * when multiple tabs/subdomains try to refresh simultaneously.
 */
async function refreshToken(): Promise<boolean> {
  try {
    const res = await fetch("/_refresh", { method: "POST", credentials: "include" });

    if (res.status === 404) {
      // Endpoint doesn't exist - we're in standalone mode, no refresh needed
      return true;
    }

    if (res.ok) {
      console.log("[token-refresh] Token refreshed successfully");
      return true;
    }

    const data = await res.json().catch(() => ({}));

    // Check for "already_used" error - another tab may have just refreshed
    // In this case, wait a moment and retry (cookie should now have new token)
    if (isRefreshTokenAlreadyUsedError(data)) {
      console.log("[token-refresh] Token already used by another tab, retrying in 2s...");
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      const retryRes = await fetch("/_refresh", { method: "POST", credentials: "include" });
      if (retryRes.ok) {
        console.log("[token-refresh] Retry successful (token refreshed by another tab)");
        return true;
      }

      const retryData = await retryRes.json().catch(() => ({}));
      console.warn("[token-refresh] Retry also failed:", retryRes.status, retryData);
      return false;
    }

    console.warn("[token-refresh] Token refresh failed:", res.status, data);
    return false;
  } catch (err) {
    console.error("[token-refresh] Error:", err);
    return false;
  }
}

/**
 * Check if the error response indicates refresh_token_already_used.
 * Handles both our custom error format and Supabase's raw error format.
 */
function isRefreshTokenAlreadyUsedError(data: Record<string, unknown>): boolean {
  // Our custom error format: { error: { code: "REFRESH_TOKEN_ALREADY_USED" } }
  const errorCode = (data?.error as Record<string, unknown>)?.code;
  if (errorCode === "REFRESH_TOKEN_ALREADY_USED") {
    return true;
  }

  // Supabase raw error format: { code: "refresh_token_already_used", message: "..." }
  if (data?.code === "refresh_token_already_used") {
    return true;
  }

  // Fallback: check message string (only if it's actually a string)
  const errorObj = data?.error as Record<string, unknown> | undefined;
  const rawMessage = data?.message ?? errorObj?.message;
  if (typeof rawMessage === "string") {
    return rawMessage.toLowerCase().includes("already used");
  }
  return false;
}

/**
 * Calculate a random refresh interval with jitter.
 * This reduces the probability of multiple tabs refreshing simultaneously.
 */
function calculateRefreshInterval(): number {
  const jitter = Math.random() * RANDOM_JITTER_MS * 2 - RANDOM_JITTER_MS;
  const interval = BASE_INTERVAL_MS + jitter;
  return Math.max(interval, 10 * 60 * 1000); // Minimum 10 minutes
}

/**
 * Start the token refresh polling.
 * - Detects if we're in OpenClaw Cloud environment
 * - If so, refreshes token immediately and at random intervals (25-35 min)
 */
export async function startTokenRefresh(): Promise<void> {
  if (tokenRefreshInterval) {
    return; // Already running
  }

  // Dev mode: skip auto-refresh to avoid race condition with Dashboard
  // (Supabase refresh_token is one-time use, simultaneous refresh causes "already_used" error)
  // Dashboard sets the cookie via /_auth, that's sufficient for dev testing (token valid 1hr)
  if (window.location.hostname.includes("localhost")) {
    console.log("[token-refresh] Dev mode detected, skipping auto-refresh (token valid 1hr)");
    return;
  }

  // Detect environment
  const isCloud = await detectCloudEnvironment();
  if (!isCloud) {
    console.log("[token-refresh] Standalone mode detected, token refresh disabled");
    return;
  }

  console.log("[token-refresh] Cloud mode detected, starting token refresh");

  // Refresh immediately on start
  await refreshToken();

  // Schedule next refresh with random jitter
  scheduleNextRefresh();
}

/**
 * Schedule the next token refresh with random jitter.
 */
function scheduleNextRefresh(): void {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
  }

  const interval = calculateRefreshInterval();
  const intervalMinutes = Math.round(interval / 60000);

  console.log(`[token-refresh] Next refresh in ${intervalMinutes} minutes`);

  tokenRefreshInterval = setInterval(() => {
    void refreshToken();
    // Reschedule with new random interval
    scheduleNextRefresh();
  }, interval);
}

/**
 * Stop the token refresh polling.
 */
export function stopTokenRefresh(): void {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
    console.log("[token-refresh] Token refresh stopped");
  }
}
