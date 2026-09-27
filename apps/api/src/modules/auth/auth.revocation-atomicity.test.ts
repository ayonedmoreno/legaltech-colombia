import { describe, expect, it } from "vitest";
import { cookieHeader, findSetCookie } from "../../test-support/cookies.js";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import type { SessionRevokedReason } from "@legaltech/database";
import type { AuditLogEntry } from "./auth.types.js";

/**
 * H1: logout, DELETE /api/auth/sessions/:sessionId and logout-all revoke and audit in one
 * transaction, as password/reset does: both are kept, or neither, and a repeated or concurrent
 * revocation writes no second event. The PostgreSQL transaction itself is covered by
 * auth.repository.integration.test.ts; here, that the service no longer writes the event apart.
 */
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct horse battery";

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
type App = TestApp["app"];

interface Login {
  sessionRaw: string;
  csrfRaw: string;
  sessionId: string;
}

/** Fails the audit write of the given action, as a failing INSERT would in the transaction. */
class FailingAuditRepository extends FakeAuthRepository {
  constructor(private readonly failingAction: string) {
    super();
  }
  protected override recordAudit(entry: AuditLogEntry): void {
    if (entry.action === this.failingAction) throw new Error("audit write failed");
    super.recordAudit(entry);
  }
}

/** Fails every revocation, as a failing UPDATE would in the transaction. */
class FailingRevocationRepository extends FakeAuthRepository {
  failRevocations = false;
  override async revokeSession(id: string, reason: SessionRevokedReason, audit?: AuditLogEntry) {
    if (this.failRevocations) throw new Error("revocation failed");
    return super.revokeSession(id, reason, audit);
  }
  override async revokeOwnSession(
    sessionId: string,
    userId: string,
    now: Date,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ) {
    if (this.failRevocations) throw new Error("revocation failed");
    return super.revokeOwnSession(sessionId, userId, now, reason, audit);
  }
  override async revokeAllOwnSessions(
    userId: string,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ) {
    if (this.failRevocations) throw new Error("revocation failed");
    return super.revokeAllOwnSessions(userId, reason, audit);
  }
}

async function register(app: App, email: string) {
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD, fullName: "Ana Gómez" },
  });
}

async function login(testApp: TestApp, email: string): Promise<Login> {
  const response = await testApp.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const sessions = [...testApp.repository.sessions.values()];
  return {
    sessionRaw: findSetCookie(response.headers["set-cookie"], "__Host-session")!.value,
    csrfRaw: findSetCookie(response.headers["set-cookie"], "__Host-csrf")!.value,
    sessionId: sessions[sessions.length - 1]!.id,
  };
}

function headersFor(as: Login) {
  return {
    origin: ORIGIN,
    "x-csrf-token": as.csrfRaw,
    cookie: cookieHeader({ "__Host-session": as.sessionRaw, "__Host-csrf": as.csrfRaw }),
  };
}

const logout = (app: App, as: Login) =>
  app.inject({ method: "POST", url: "/api/auth/logout", headers: headersFor(as) });
const revoke = (app: App, as: Login, sessionId: string) =>
  app.inject({ method: "DELETE", url: `/api/auth/sessions/${sessionId}`, headers: headersFor(as) });
const logoutAll = (app: App, as: Login) =>
  app.inject({ method: "POST", url: "/api/auth/logout-all", headers: headersFor(as) });

const events = (testApp: TestApp, action: string) =>
  testApp.repository.auditLog.filter((e) => e.action === action);

const isActive = (testApp: TestApp, sessionId: string) =>
  testApp.repository.sessions.get(sessionId)!.revokedAt === null;

describe("revocation and audit are atomic (H1)", () => {
  describe("rollback if the audit fails", () => {
    it("logout: 500, the session stays valid and no event is kept", async () => {
      const testApp = await buildTestApp({ repository: new FailingAuditRepository("auth.logout") });
      await register(testApp.app, "ana@example.com");
      const ana = await login(testApp, "ana@example.com");

      const response = await logout(testApp.app, ana);

      expect(response.statusCode).toBe(500);
      expect(isActive(testApp, ana.sessionId)).toBe(true);
      expect(events(testApp, "auth.logout")).toHaveLength(0);
    });

    it("DELETE session: 500, the session stays valid and no event is kept", async () => {
      const testApp = await buildTestApp({
        repository: new FailingAuditRepository("auth.session.revoked"),
      });
      await register(testApp.app, "ana@example.com");
      const current = await login(testApp, "ana@example.com");
      const other = await login(testApp, "ana@example.com");

      const response = await revoke(testApp.app, current, other.sessionId);

      expect(response.statusCode).toBe(500);
      expect(isActive(testApp, other.sessionId)).toBe(true);
      expect(events(testApp, "auth.session.revoked")).toHaveLength(0);
    });

    it("logout-all: 500, every session stays valid and no event is kept", async () => {
      const testApp = await buildTestApp({
        repository: new FailingAuditRepository("auth.logout_all"),
      });
      await register(testApp.app, "ana@example.com");
      const first = await login(testApp, "ana@example.com");
      const second = await login(testApp, "ana@example.com");

      const response = await logoutAll(testApp.app, second);

      expect(response.statusCode).toBe(500);
      expect(isActive(testApp, first.sessionId)).toBe(true);
      expect(isActive(testApp, second.sessionId)).toBe(true);
      expect(events(testApp, "auth.logout_all")).toHaveLength(0);
    });
  });

  describe("rollback if the revocation fails", () => {
    async function setUp() {
      const repository = new FailingRevocationRepository();
      const testApp = await buildTestApp({ repository });
      await register(testApp.app, "ana@example.com");
      const first = await login(testApp, "ana@example.com");
      const second = await login(testApp, "ana@example.com");
      repository.failRevocations = true;
      return { testApp, first, second };
    }

    it("logout: 500 and no event is written apart", async () => {
      const { testApp, second } = await setUp();
      expect((await logout(testApp.app, second)).statusCode).toBe(500);
      expect(isActive(testApp, second.sessionId)).toBe(true);
      expect(events(testApp, "auth.logout")).toHaveLength(0);
    });

    it("DELETE session: 500 and no event is written apart", async () => {
      const { testApp, first, second } = await setUp();
      expect((await revoke(testApp.app, second, first.sessionId)).statusCode).toBe(500);
      expect(isActive(testApp, first.sessionId)).toBe(true);
      expect(events(testApp, "auth.session.revoked")).toHaveLength(0);
    });

    it("logout-all: 500 and no event is written apart", async () => {
      const { testApp, second } = await setUp();
      expect((await logoutAll(testApp.app, second)).statusCode).toBe(500);
      expect(isActive(testApp, second.sessionId)).toBe(true);
      expect(events(testApp, "auth.logout_all")).toHaveLength(0);
    });
  });

  describe("both kept together", () => {
    it("logout: the session is revoked with LOGOUT and exactly one event names it", async () => {
      const testApp = await buildTestApp();
      await register(testApp.app, "ana@example.com");
      const ana = await login(testApp, "ana@example.com");

      expect((await logout(testApp.app, ana)).statusCode).toBe(204);

      expect(testApp.repository.sessions.get(ana.sessionId)!.revokedReason).toBe("LOGOUT");
      const logged = events(testApp, "auth.logout");
      expect(logged).toHaveLength(1);
      expect(logged[0]!.entityId).toBe(ana.sessionId);
    });

    it("DELETE session: the session is revoked and exactly one event names it", async () => {
      const testApp = await buildTestApp();
      await register(testApp.app, "ana@example.com");
      const current = await login(testApp, "ana@example.com");
      const other = await login(testApp, "ana@example.com");

      expect((await revoke(testApp.app, current, other.sessionId)).statusCode).toBe(204);

      expect(testApp.repository.sessions.get(other.sessionId)!.revokedReason).toBe("LOGOUT");
      const logged = events(testApp, "auth.session.revoked");
      expect(logged).toHaveLength(1);
      expect(logged[0]!.entityId).toBe(other.sessionId);
    });

    it("logout-all: every session is revoked and exactly one event is kept", async () => {
      const testApp = await buildTestApp();
      await register(testApp.app, "ana@example.com");
      const first = await login(testApp, "ana@example.com");
      const second = await login(testApp, "ana@example.com");

      expect((await logoutAll(testApp.app, second)).statusCode).toBe(204);

      expect(testApp.repository.sessions.get(first.sessionId)!.revokedReason).toBe("LOGOUT_ALL");
      expect(testApp.repository.sessions.get(second.sessionId)!.revokedReason).toBe("LOGOUT_ALL");
      expect(events(testApp, "auth.logout_all")).toHaveLength(1);
    });
  });

  describe("no duplicate events", () => {
    it("two concurrent logouts of the same session write one event", async () => {
      const testApp = await buildTestApp();
      await register(testApp.app, "ana@example.com");
      const ana = await login(testApp, "ana@example.com");

      const responses = await Promise.all([logout(testApp.app, ana), logout(testApp.app, ana)]);

      expect(responses.map((r) => r.statusCode)).toEqual([204, 204]);
      expect(events(testApp, "auth.logout")).toHaveLength(1);
    });

    it("two concurrent DELETEs of the same session: one 204, one 404, one event", async () => {
      const testApp = await buildTestApp();
      await register(testApp.app, "ana@example.com");
      const current = await login(testApp, "ana@example.com");
      const other = await login(testApp, "ana@example.com");

      const responses = await Promise.all([
        revoke(testApp.app, current, other.sessionId),
        revoke(testApp.app, current, other.sessionId),
      ]);

      expect(responses.map((r) => r.statusCode).sort()).toEqual([204, 404]);
      expect(events(testApp, "auth.session.revoked")).toHaveLength(1);
    });

    it("two concurrent logout-alls write one event", async () => {
      const testApp = await buildTestApp();
      await register(testApp.app, "ana@example.com");
      await login(testApp, "ana@example.com");
      const second = await login(testApp, "ana@example.com");

      await Promise.all([logoutAll(testApp.app, second), logoutAll(testApp.app, second)]);

      expect(events(testApp, "auth.logout_all")).toHaveLength(1);
    });
  });
});
