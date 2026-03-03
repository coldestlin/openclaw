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
 */

let tokenRefreshInterval: ReturnType<typeof setInterval> | null = null;
let isCloudEnvironment: boolean | null = null;

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
    console.warn("[token-refresh] Token refresh failed:", res.status, data);
    return false;
  } catch (err) {
    console.error("[token-refresh] Error:", err);
    return false;
  }
}

/**
 * Start the token refresh polling.
 * - Detects if we're in OpenClaw Cloud environment
 * - If so, refreshes token immediately and every 50 minutes
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

  // Then refresh every 30 minutes (JWT typically expires in 60 minutes)
  tokenRefreshInterval = setInterval(
    () => {
      void refreshToken();
    },
    30 * 60 * 1000,
  );
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
