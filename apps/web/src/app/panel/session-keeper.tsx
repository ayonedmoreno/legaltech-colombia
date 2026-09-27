"use client";

import { useEffect } from "react";
import { rotateSession } from "../../lib/api-client";
import { SESSION_ROTATION_CHECK_INTERVAL_MS } from "../../lib/session-rotation";

/**
 * Periodic session rotation while a protected page is open (ADR-002: "periódicamente durante el
 * uso"). It runs in the browser on purpose: the rotation's new cookies must reach the browser,
 * which they would not if the web server's own session check (GET /api/auth/me) triggered it.
 * Failures are ignored: the session simply stays as it is until the next check.
 */
export function SessionKeeper() {
  useEffect(() => {
    void rotateSession();
    const timer = window.setInterval(
      () => void rotateSession(),
      SESSION_ROTATION_CHECK_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, []);
  return null;
}
