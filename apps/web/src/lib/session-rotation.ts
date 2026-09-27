/**
 * How often an open protected page asks the API whether the session is due for rotation. The
 * rotation intervals themselves (1 h for USER, 15 min for internal roles) and the 60 s grace
 * period are decided by the API (ADR-002; Sprint 1B decisions P10/P11); checking every 5 minutes
 * keeps an internal session at most 5 minutes past its interval.
 */
export const SESSION_ROTATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
