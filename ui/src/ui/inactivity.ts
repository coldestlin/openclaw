/**
 * User inactivity detection module for WebChat.
 *
 * When user is inactive for a period of time, this module stops heartbeat
 * and token refresh to allow the Machine to naturally suspend (scale-to-zero).
 * When user becomes active again, it resumes heartbeat and token refresh.
 *
 * This saves resources when users leave WebChat open but aren't using it.
 */

import { startHeartbeat, stopHeartbeat } from "./heartbeat.ts";
import { startTokenRefresh, stopTokenRefresh } from "./token-refresh.ts";

let inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
let isActive = true;

// Configuration
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of inactivity

// User activity events to monitor
const ACTIVITY_EVENTS = ["mousemove", "keydown", "scroll", "click", "touchstart"];

/**
 * Reset the inactivity timer. Called on every user activity.
 * If user was inactive, this also resumes heartbeat and token refresh.
 */
function resetInactivityTimer(): void {
  if (!isActive) {
    // User was inactive, now active again
    console.log("[inactivity] User active again, resuming heartbeat and token refresh");
    isActive = true;
    void startHeartbeat();
    void startTokenRefresh();
  }

  // Reset the timeout
  if (inactivityTimeout) {
    clearTimeout(inactivityTimeout);
  }

  inactivityTimeout = setTimeout(() => {
    if (!isActive) {
      // Already inactive (shouldn't happen, but safety check)
      return;
    }

    console.log("[inactivity] User inactive for 5 minutes, stopping heartbeat and token refresh");
    isActive = false;
    stopHeartbeat();
    stopTokenRefresh();
    // Machine will auto-suspend after 5 more minutes (ManagerDO alarm detects no activity)
  }, INACTIVITY_TIMEOUT_MS);
}

/**
 * Start monitoring user activity.
 * Call this when WebChat connects.
 */
export function startInactivityDetection(): void {
  // Listen for user activity events
  ACTIVITY_EVENTS.forEach((event) => {
    document.addEventListener(event, resetInactivityTimer, { passive: true });
  });

  // Start the initial timer
  resetInactivityTimer();
  console.log("[inactivity] Detection started, will stop heartbeat after 5 min of inactivity");
}

/**
 * Stop monitoring user activity.
 * Call this when WebChat disconnects.
 */
export function stopInactivityDetection(): void {
  // Remove event listeners
  ACTIVITY_EVENTS.forEach((event) => {
    document.removeEventListener(event, resetInactivityTimer);
  });

  // Clear any pending timeout
  if (inactivityTimeout) {
    clearTimeout(inactivityTimeout);
    inactivityTimeout = null;
  }

  console.log("[inactivity] Detection stopped");
}

/**
 * Check if user is currently active.
 * Useful for debugging or conditional behavior.
 */
export function isUserActive(): boolean {
  return isActive;
}
