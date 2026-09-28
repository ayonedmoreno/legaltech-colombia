import { createHash, randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { HttpError } from "../../common/http-error.js";
import { hashPassword } from "../../security/password.js";
import { TEST_ENV } from "../../test-support/build-test-app.js";
import { LOGIN_LOCK_NAMESPACE, PrismaAuthRepository, loginLockKey } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { PrismaCasesRepository } from "../cases/cases.repository.js";
import { CasesService } from "../cases/cases.service.js";
import { PrismaDocumentsRepository } from "../documents/documents.repository.js";
import { DocumentsService } from "../documents/documents.service.js";
import { MemoryStorageProvider } from "../../storage/storage.fake.js";
import {
  DuplicateEmailError,
  LoginAttemptUnavailableError,
  type CreateSessionInput,
  type LoginAttemptScope,
} from "./auth.types.js";

/**
 * PrismaAuthRepository against real PostgreSQL (the fake covers everything else).
 *
 * Opt-in: runs only when INTEGRATION_DATABASE_URL is set, and is reported as skipped
 * otherwise. CI sets it, after the migrations and the append-only check, to the application
 * role (same privileges as the API at runtime). Never point it at a development database:
 * the audit_logs rows these tests write can never be deleted (append-only). Every test uses
 * its own UUID-based data, so runs never collide.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;

const MINUTE_MS = 60 * 1000;
const PASSWORD = "correct horse battery";

describe.skipIf(!databaseUrl)("PrismaAuthRepository (PostgreSQL integration)", () => {
  let prisma: PrismaClient;
  let repository: PrismaAuthRepository;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
    repository = new PrismaAuthRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const uniqueEmail = () => `it-${randomUUID()}@example.com`;
  const uniqueHash = () => createHash("sha256").update(randomUUID()).digest("hex");

  function newUser() {
    return repository.createUser({
      email: uniqueEmail(),
      passwordHash: "$argon2id$integration-test-placeholder",
      fullName: "Integración",
    });
  }

  function sessionInput(userId: string, overrides: Partial<CreateSessionInput> = {}) {
    const now = new Date();
    return {
      userId,
      tokenHash: uniqueHash(),
      csrfTokenHash: uniqueHash(),
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + 60 * MINUTE_MS),
      absoluteExpiresAt: new Date(now.getTime() + 24 * 60 * MINUTE_MS),
      ip: "203.0.113.7",
      userAgent: "integration-test",
      ...overrides,
    } satisfies CreateSessionInput;
  }

  describe("users", () => {
    it("createUser stores a USER, ACTIVE, unverified account", async () => {
      const email = uniqueEmail();
      const user = await repository.createUser({
        email,
        passwordHash: "$argon2id$integration-test-placeholder",
        fullName: "Ana Gómez",
      });

      expect(user).toMatchObject({
        email,
        fullName: "Ana Gómez",
        role: "USER",
        status: "ACTIVE",
        emailVerifiedAt: null,
      });
      expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(user.createdAt).toBeInstanceOf(Date);
    });

    it("maps the real unique violation (P2002) on users.email to DuplicateEmailError", async () => {
      const user = await newUser();
      await expect(
        repository.createUser({ email: user.email, passwordHash: "x", fullName: "Otra" }),
      ).rejects.toBeInstanceOf(DuplicateEmailError);
    });

    it("lets exactly one of two concurrent inserts of the same email win", async () => {
      const email = uniqueEmail();
      const input = { email, passwordHash: "x", fullName: "Carrera" };

      const results = await Promise.allSettled([
        repository.createUser(input),
        repository.createUser(input),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateEmailError);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it("findUserByEmail finds an existing user and returns null for an unknown email", async () => {
      const user = await newUser();
      expect((await repository.findUserByEmail(user.email))?.id).toBe(user.id);
      expect(await repository.findUserByEmail(uniqueEmail())).toBeNull();
    });

    it("findUserById finds an existing user and returns null for an unknown id", async () => {
      const user = await newUser();
      expect((await repository.findUserById(user.id))?.email).toBe(user.email);
      expect(await repository.findUserById(randomUUID())).toBeNull();
    });
  });

  describe("sessions", () => {
    it("createSession stores the session, found again by its token hash", async () => {
      const user = await newUser();
      const input = sessionInput(user.id);

      const created = await repository.createSession(input);
      const found = await repository.findSessionByTokenHash(input.tokenHash);

      expect(found).toMatchObject({
        id: created.id,
        userId: user.id,
        tokenHash: input.tokenHash,
        csrfTokenHash: input.csrfTokenHash,
        revokedAt: null,
        revokedReason: null,
      });
      expect(found?.absoluteExpiresAt.getTime()).toBe(input.absoluteExpiresAt.getTime());
      expect(await repository.findSessionByTokenHash(uniqueHash())).toBeNull();
    });

    it.each(["203.0.113.7", "2001:db8::1", "::ffff:127.0.0.1"])(
      "stores the client IP %s in the real inet column",
      async (ip) => {
        const user = await newUser();
        const session = await repository.createSession(sessionInput(user.id, { ip }));

        const [row] = await prisma.$queryRaw<Array<{ type: string; ip: string }>>`
          SELECT pg_typeof(ip)::text AS type, host(ip) AS ip FROM sessions WHERE id = ${session.id}::uuid`;
        expect(row?.type).toBe("inet");
        expect(row?.ip).toBe(ip);
      },
    );

    it("rejects a value that is not an IP address (the column is really inet)", async () => {
      const user = await newUser();
      await expect(
        repository.createSession(sessionInput(user.id, { ip: "not-an-ip" })),
      ).rejects.toThrow();
    });

    it("touchSession slides lastSeenAt and idleExpiresAt", async () => {
      const user = await newUser();
      const input = sessionInput(user.id);
      const session = await repository.createSession(input);
      const lastSeenAt = new Date(input.lastSeenAt.getTime() + MINUTE_MS);
      const idleExpiresAt = new Date(input.idleExpiresAt.getTime() + MINUTE_MS);

      await repository.touchSession(session.id, { lastSeenAt, idleExpiresAt });

      const found = await repository.findSessionByTokenHash(input.tokenHash);
      expect(found?.lastSeenAt.getTime()).toBe(lastSeenAt.getTime());
      expect(found?.idleExpiresAt.getTime()).toBe(idleExpiresAt.getTime());
      expect(found?.absoluteExpiresAt.getTime()).toBe(input.absoluteExpiresAt.getTime());
    });

    it("rotateSessionCsrf replaces only the CSRF token hash", async () => {
      const user = await newUser();
      const input = sessionInput(user.id);
      const session = await repository.createSession(input);
      const rotated = uniqueHash();

      await repository.rotateSessionCsrf(session.id, rotated);

      const found = await repository.findSessionByTokenHash(input.tokenHash);
      expect(found?.csrfTokenHash).toBe(rotated);
      expect(found?.tokenHash).toBe(input.tokenHash);
    });

    it("revokeSession is one-way: a second revocation keeps the first reason and time", async () => {
      const user = await newUser();
      const input = sessionInput(user.id);
      const session = await repository.createSession(input);

      await repository.revokeSession(session.id, "LOGOUT");
      const first = await repository.findSessionByTokenHash(input.tokenHash);
      await repository.revokeSession(session.id, "ADMIN_REVOKE");
      const second = await repository.findSessionByTokenHash(input.tokenHash);

      expect(first?.revokedReason).toBe("LOGOUT");
      expect(first?.revokedAt).toBeInstanceOf(Date);
      expect(second?.revokedReason).toBe("LOGOUT");
      expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
    });

    it("listActiveSessions returns only the user's valid sessions, most recently used first", async () => {
      const user = await newUser();
      const other = await newUser();
      const now = new Date();
      const minutesAgo = (m: number) => new Date(now.getTime() - m * MINUTE_MS);
      const later = new Date(now.getTime() + 60 * MINUTE_MS);

      const older = await repository.createSession(
        sessionInput(user.id, { lastSeenAt: minutesAgo(10), ip: "2001:db8::1", userAgent: "old" }),
      );
      const newer = await repository.createSession(
        sessionInput(user.id, { lastSeenAt: minutesAgo(1), userAgent: "new" }),
      );
      const revoked = await repository.createSession(sessionInput(user.id));
      await repository.revokeSession(revoked.id, "LOGOUT");
      await repository.createSession(sessionInput(user.id, { idleExpiresAt: minutesAgo(1) }));
      await repository.createSession(
        sessionInput(user.id, { idleExpiresAt: later, absoluteExpiresAt: minutesAgo(1) }),
      );
      await repository.createSession(sessionInput(other.id));

      const listed = await repository.listActiveSessions(user.id, now);

      expect(listed.map((s) => s.id)).toEqual([newer.id, older.id]);
      expect(listed[1]).toMatchObject({ userId: user.id, ip: "2001:db8::1", userAgent: "old" });
      expect(listed[0]?.ip).toBe("203.0.113.7");
      expect(await repository.listActiveSessions(randomUUID(), now)).toEqual([]);
    });

    it("revokeOwnSession revokes only the user's own valid session, once", async () => {
      const user = await newUser();
      const other = await newUser();
      const now = new Date();
      const own = sessionInput(user.id);
      const ownSession = await repository.createSession(own);
      const foreign = sessionInput(other.id);
      const foreignSession = await repository.createSession(foreign);
      const expired = await repository.createSession(
        sessionInput(user.id, { idleExpiresAt: new Date(now.getTime() - MINUTE_MS) }),
      );

      expect(await repository.revokeOwnSession(foreignSession.id, user.id, now, "LOGOUT")).toBe(
        false,
      );
      expect(await repository.revokeOwnSession(expired.id, user.id, now, "LOGOUT")).toBe(false);
      expect(await repository.revokeOwnSession(randomUUID(), user.id, now, "LOGOUT")).toBe(false);
      expect((await repository.findSessionByTokenHash(foreign.tokenHash))?.revokedAt).toBeNull();

      expect(await repository.revokeOwnSession(ownSession.id, user.id, now, "LOGOUT")).toBe(true);
      const revoked = await repository.findSessionByTokenHash(own.tokenHash);
      expect(revoked?.revokedReason).toBe("LOGOUT");
      expect(revoked?.revokedAt).toBeInstanceOf(Date);

      // A second revocation changes nothing: one-way, first reason and time kept.
      expect(await repository.revokeOwnSession(ownSession.id, user.id, now, "LOGOUT_ALL")).toBe(
        false,
      );
      const again = await repository.findSessionByTokenHash(own.tokenHash);
      expect(again?.revokedReason).toBe("LOGOUT");
      expect(again?.revokedAt?.getTime()).toBe(revoked?.revokedAt?.getTime());
    });

    it("revokeAllOwnSessions revokes all of the user's unrevoked sessions and nobody else's", async () => {
      const user = await newUser();
      const other = await newUser();
      const now = new Date();
      const live = [sessionInput(user.id), sessionInput(user.id)];
      for (const input of live) await repository.createSession(input);
      const expired = sessionInput(user.id, { idleExpiresAt: new Date(now.getTime() - MINUTE_MS) });
      await repository.createSession(expired);
      const earlier = sessionInput(user.id);
      const earlierSession = await repository.createSession(earlier);
      await repository.revokeSession(earlierSession.id, "LOGOUT");
      const firstRevokedAt = (await repository.findSessionByTokenHash(earlier.tokenHash))
        ?.revokedAt;
      const foreign = sessionInput(other.id);
      await repository.createSession(foreign);

      expect(await repository.revokeAllOwnSessions(user.id, "LOGOUT_ALL")).toBe(3);

      for (const input of [...live, expired]) {
        expect((await repository.findSessionByTokenHash(input.tokenHash))?.revokedReason).toBe(
          "LOGOUT_ALL",
        );
      }
      const earlierAfter = await repository.findSessionByTokenHash(earlier.tokenHash);
      expect(earlierAfter?.revokedReason).toBe("LOGOUT");
      expect(earlierAfter?.revokedAt?.getTime()).toBe(firstRevokedAt?.getTime());
      expect((await repository.findSessionByTokenHash(foreign.tokenHash))?.revokedAt).toBeNull();
      // Nothing left to revoke: a second call changes nothing.
      expect(await repository.revokeAllOwnSessions(user.id, "LOGOUT_ALL")).toBe(0);
    });
  });

  describe("revocation and its audit event in one transaction (H1)", () => {
    function revocationAudit(userId: string, entityId: string, action: string) {
      return {
        actorUserId: userId,
        actorRole: "USER" as const,
        action,
        entityType: "Session",
        entityId,
        requestId: randomUUID(),
        ip: "203.0.113.7",
        userAgent: "integration-test",
      };
    }

    const eventCount = (action: string, entityId: string) =>
      prisma.auditLog.count({ where: { action, entityId } });

    // Each method, with the arguments that revoke the given session (entityId is the session,
    // or the user for logout-all, as the service writes it).
    const methods = [
      {
        name: "revokeSession (logout)",
        action: "auth.logout",
        entity: (s: { id: string; userId: string }) => s.id,
        revoke: (s: { id: string; userId: string }, reason: string, audit?: object) =>
          repository.revokeSession(s.id, reason as never, audit as never),
      },
      {
        name: "revokeOwnSession (DELETE)",
        action: "auth.session.revoked",
        entity: (s: { id: string; userId: string }) => s.id,
        revoke: (s: { id: string; userId: string }, reason: string, audit?: object) =>
          repository.revokeOwnSession(s.id, s.userId, new Date(), reason as never, audit as never),
      },
      {
        name: "revokeAllOwnSessions (logout-all)",
        action: "auth.logout_all",
        entity: (s: { id: string; userId: string }) => s.userId,
        revoke: (s: { id: string; userId: string }, reason: string, audit?: object) =>
          repository.revokeAllOwnSessions(s.userId, reason as never, audit as never),
      },
    ];

    for (const method of methods) {
      describe(method.name, () => {
        async function newSession() {
          const user = await newUser();
          const input = sessionInput(user.id);
          const session = await repository.createSession(input);
          return { session: { id: session.id, userId: user.id }, tokenHash: input.tokenHash };
        }

        it("a failing audit write rolls the revocation back", async () => {
          const { session, tokenHash } = await newSession();
          const entityId = method.entity(session);
          // An invalid inet value makes the INSERT fail inside the transaction.
          const audit = { ...revocationAudit(session.userId, entityId, method.action), ip: "x" };

          await expect(method.revoke(session, "LOGOUT", audit)).rejects.toThrow();

          expect((await repository.findSessionByTokenHash(tokenHash))?.revokedAt).toBeNull();
          expect(await eventCount(method.action, entityId)).toBe(0);
        });

        it("a failing revocation writes no event", async () => {
          const { session, tokenHash } = await newSession();
          const entityId = method.entity(session);
          const audit = revocationAudit(session.userId, entityId, method.action);

          await expect(method.revoke(session, "NOT_A_REASON", audit)).rejects.toThrow();

          expect((await repository.findSessionByTokenHash(tokenHash))?.revokedAt).toBeNull();
          expect(await eventCount(method.action, entityId)).toBe(0);
        });

        it("on success both are kept together", async () => {
          const { session, tokenHash } = await newSession();
          const entityId = method.entity(session);
          const audit = revocationAudit(session.userId, entityId, method.action);

          expect(await method.revoke(session, "LOGOUT", audit)).toBeTruthy();

          expect((await repository.findSessionByTokenHash(tokenHash))?.revokedReason).toBe(
            "LOGOUT",
          );
          expect(await eventCount(method.action, entityId)).toBe(1);
        });

        it("concurrent revocations write a single event", async () => {
          const { session } = await newSession();
          const entityId = method.entity(session);

          const results = await Promise.all(
            Array.from({ length: 5 }, () =>
              method.revoke(
                session,
                "LOGOUT",
                revocationAudit(session.userId, entityId, method.action),
              ),
            ),
          );

          expect(results.filter(Boolean)).toHaveLength(1);
          expect(await eventCount(method.action, entityId)).toBe(1);
        });
      });
    }
  });

  describe("audit log", () => {
    async function failedLogin(emailHash: string, occurredAt?: Date) {
      // A backdated event cannot be written through the repository (occurred_at defaults to
      // now()), so the window test inserts it directly, as the application role may.
      if (occurredAt) {
        await prisma.auditLog.create({
          data: { action: "auth.login.failed", metadata: { emailHash }, occurredAt },
        });
        return;
      }
      await repository.writeAuditLog({
        actorUserId: null,
        actorRole: null,
        action: "auth.login.failed",
        metadata: { emailHash },
        requestId: randomUUID(),
        ip: "203.0.113.7",
        userAgent: "integration-test",
      });
    }

    /** The failure count a login attempt sees for this hash and window (PostgreSQL time). */
    const recentFailures = (emailHash: string, windowMs: number) =>
      repository.runLoginAttempt(emailHash, windowMs, async (scope) => scope.recentFailures);

    it("a login attempt counts only failed logins for its email hash (JSON filter)", async () => {
      const target = uniqueHash();
      const other = uniqueHash();
      await failedLogin(target);
      await failedLogin(target);
      await failedLogin(target);
      await failedLogin(other);
      // Same hash, but not a failed login: must not count.
      await repository.writeAuditLog({
        actorUserId: null,
        actorRole: null,
        action: "auth.login.success",
        metadata: { emailHash: target },
        requestId: randomUUID(),
        ip: null,
        userAgent: null,
      });

      expect(await recentFailures(target, 5 * MINUTE_MS)).toBe(3);
      expect(await recentFailures(other, 5 * MINUTE_MS)).toBe(1);
      expect(await recentFailures(uniqueHash(), 5 * MINUTE_MS)).toBe(0);
    });

    it("a login attempt only counts events inside its window, measured on PostgreSQL time", async () => {
      const target = uniqueHash();
      await failedLogin(target, new Date(Date.now() - 20 * MINUTE_MS));
      await failedLogin(target);

      expect(await recentFailures(target, 15 * MINUTE_MS)).toBe(1);
      expect(await recentFailures(target, 30 * MINUTE_MS)).toBe(2);
    });

    it("writeAuditLog stores every field, metadata as JSON and the IP as inet", async () => {
      const user = await newUser();
      const requestId = randomUUID();

      await repository.writeAuditLog({
        actorUserId: user.id,
        actorRole: "USER",
        action: "auth.register",
        entityType: "User",
        entityId: user.id,
        metadata: { outcome: "created", nested: { count: 1 } },
        requestId,
        ip: "2001:db8::7",
        userAgent: "integration-test",
      });

      const stored = await prisma.auditLog.findFirst({ where: { requestId } });
      expect(stored).toMatchObject({
        actorUserId: user.id,
        actorRole: "USER",
        action: "auth.register",
        entityType: "User",
        entityId: user.id,
        metadata: { outcome: "created", nested: { count: 1 } },
        userAgent: "integration-test",
      });
      expect(stored?.occurredAt).toBeInstanceOf(Date);
      const [row] = await prisma.$queryRaw<Array<{ ip: string }>>`
        SELECT host(ip) AS ip FROM audit_logs WHERE request_id = ${requestId}`;
      expect(row?.ip).toBe("2001:db8::7");
    });
  });

  describe("login attempts: per-account atomicity (ADR-002, D3)", () => {
    const LIMIT = 5;
    const WINDOW_MS = 15 * MINUTE_MS;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function failure(emailHash: string, requestId = randomUUID()) {
      return {
        actorUserId: null,
        actorRole: null,
        action: "auth.login.failed",
        metadata: { emailHash },
        requestId,
        ip: "203.0.113.7",
        userAgent: "integration-test",
      };
    }

    const storedFailures = (emailHash: string) =>
      prisma.auditLog.count({
        where: {
          action: "auth.login.failed",
          metadata: { path: ["emailHash"], equals: emailHash },
        },
      });

    /** Holds the account's advisory lock in its own transaction for `ms`. */
    function holdLock(emailHash: string, ms: number) {
      return prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOGIN_LOCK_NAMESPACE}::int, ${loginLockKey(emailHash)}::int)`;
          await tx.$executeRaw`SELECT pg_sleep(${ms / 1000}::float8)`;
        },
        { timeout: ms + 5_000 },
      );
    }

    it("serializes concurrent attempts on one account: never more failures than the limit", async () => {
      const emailHash = uniqueHash();
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.runLoginAttempt(emailHash, WINDOW_MS, async (scope) => {
            if (scope.recentFailures >= LIMIT) return "throttled";
            await sleep(50); // stands in for the Argon2id verification, inside the lock
            await scope.writeAuditLog(failure(emailHash));
            return "failed";
          }),
        ),
      );

      expect(outcomes.filter((o) => o === "failed")).toHaveLength(LIMIT);
      expect(outcomes.filter((o) => o === "throttled")).toHaveLength(3);
      expect(await storedFailures(emailHash)).toBe(LIMIT);
    });

    /** A client of its own, with extra connection-string parameters. */
    const clientWith = (params: string) =>
      createPrismaClient(`${databaseUrl}${databaseUrl!.includes("?") ? "&" : "?"}${params}`);

    it("stays atomic when the connection's default isolation is REPEATABLE READ", async () => {
      // PostgreSQL startup options: the space inside the value is escaped with a backslash.
      const backslash = String.fromCharCode(92);
      const repeatableRead = clientWith(
        `connection_limit=4&options=${encodeURIComponent(
          `-c default_transaction_isolation=repeatable${backslash} read`,
        )}`,
      );
      try {
        const [setting] = await repeatableRead.$queryRaw<Array<{ isolation: string }>>`
          SELECT current_setting('default_transaction_isolation') AS isolation`;
        expect(setting!.isolation).toBe("repeatable read");

        const emailHash = uniqueHash();
        const onRepeatableRead = new PrismaAuthRepository(repeatableRead);
        const outcomes = await Promise.all(
          Array.from({ length: 8 }, () =>
            onRepeatableRead.runLoginAttempt(emailHash, WINDOW_MS, async (scope) => {
              if (scope.recentFailures >= LIMIT) return "throttled";
              await sleep(50);
              await scope.writeAuditLog(failure(emailHash));
              return "failed";
            }),
          ),
        );

        expect(outcomes.filter((o) => o === "failed")).toHaveLength(LIMIT);
        expect(outcomes.filter((o) => o === "throttled")).toHaveLength(3);
        expect(await storedFailures(emailHash)).toBe(LIMIT);
      } finally {
        await repeatableRead.$disconnect();
      }
    }, 20_000);

    it("runs a whole login on a single connection (the attempt never needs a second one)", async () => {
      const email = uniqueEmail();
      await repository.createUser({
        email,
        passwordHash: await hashPassword(PASSWORD),
        fullName: "Integración",
      });
      const oneConnection = clientWith("connection_limit=1&pool_timeout=3");
      try {
        const service = new AuthService({
          repository: new PrismaAuthRepository(oneConnection),
          isProduction: false,
        });
        const context = () => ({
          ip: "203.0.113.7",
          userAgent: "integration-test",
          requestId: randomUUID(),
        });

        const wrong = await service
          .login({ email, password: "wrong password entirely" }, context())
          .catch((error: unknown) => error);
        expect(wrong).toBeInstanceOf(HttpError);
        expect((wrong as HttpError).statusCode).toBe(401);

        const granted = await service.login({ email, password: PASSWORD }, context());
        expect(granted.user.email).toBe(email);
      } finally {
        await oneConnection.$disconnect();
      }
    }, 20_000);

    it("enforces the limit through the login service with real Argon2id and any email spelling", async () => {
      const email = uniqueEmail();
      await repository.createUser({
        email,
        passwordHash: await hashPassword(PASSWORD),
        fullName: "Integración",
      });
      const service = new AuthService({ repository, isProduction: false });
      const spellings = [email, email.toUpperCase(), ` ${email} `, email];

      const statuses = await Promise.all(
        [...spellings, ...spellings].map((spelling) =>
          service
            .login(
              { email: spelling, password: "wrong password entirely" },
              { ip: "203.0.113.7", userAgent: "integration-test", requestId: randomUUID() },
            )
            .then(
              () => 200,
              (error: unknown) => (error instanceof HttpError ? error.statusCode : -1),
            ),
        ),
      );

      expect(statuses.filter((s) => s === 401)).toHaveLength(LIMIT);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);
      expect(await storedFailures(createHash("sha256").update(email).digest("hex"))).toBe(LIMIT);
    }, 30_000);

    it("does not make other accounts wait", async () => {
      const locked = uniqueHash();
      const holder = holdLock(locked, 3_000);
      await sleep(300);

      const started = Date.now();
      await repository.runLoginAttempt(uniqueHash(), WINDOW_MS, async () => undefined);
      expect(Date.now() - started).toBeLessThan(1_000);
      await holder;
    }, 15_000);

    it("gives up after lock_timeout without running the attempt or writing anything", async () => {
      const emailHash = uniqueHash();
      const holder = holdLock(emailHash, 4_000);
      await sleep(300);

      let ran = false;
      const started = Date.now();
      await expect(
        repository.runLoginAttempt(emailHash, WINDOW_MS, async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(LoginAttemptUnavailableError);
      const waited = Date.now() - started;

      expect(ran).toBe(false);
      expect(waited).toBeGreaterThanOrEqual(1_800);
      expect(waited).toBeLessThan(3_500);
      await holder;
      expect(await storedFailures(emailHash)).toBe(0);
    }, 15_000);

    // With its only pooled connection busy, the attempt fails on whichever limit comes first:
    // Prisma's pool_timeout (P2024, no pooled connection) or the transaction's maxWait of 2 s
    // (P2028, the transaction cannot start). Both must be reported as unavailable.
    it.each([
      ["no pooled connection within pool_timeout (P2024)", 1],
      ["the transaction cannot start within maxWait (P2028)", 10],
    ])(
      "reports an attempt as unavailable when %s",
      async (_label, poolTimeoutSeconds) => {
        const onePool = createPrismaClient(
          `${databaseUrl}${databaseUrl!.includes("?") ? "&" : "?"}connection_limit=1&pool_timeout=${poolTimeoutSeconds}`,
        );
        try {
          const busy = onePool.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT pg_sleep(3)`;
            },
            { timeout: 10_000 },
          );
          await sleep(300);

          let ran = false;
          await expect(
            new PrismaAuthRepository(onePool).runLoginAttempt(uniqueHash(), WINDOW_MS, async () => {
              ran = true;
            }),
          ).rejects.toBeInstanceOf(LoginAttemptUnavailableError);
          expect(ran).toBe(false);
          await busy;
        } finally {
          await onePool.$disconnect();
        }
      },
      15_000,
    );

    it("reports an attempt whose transaction expires (P2028) as unavailable, and rolls it back", async () => {
      const emailHash = uniqueHash();

      await expect(
        repository.runLoginAttempt(emailHash, WINDOW_MS, async (scope) => {
          await scope.writeAuditLog(failure(emailHash));
          await sleep(6_000); // longer than the transaction's 5 s timeout
        }),
      ).rejects.toBeInstanceOf(LoginAttemptUnavailableError);
      expect(await storedFailures(emailHash)).toBe(0);
    }, 20_000);

    it("rolls back the attempt's writes when it fails, and propagates its error unchanged", async () => {
      const emailHash = uniqueHash();
      const boom = new Error("verification crashed");

      await expect(
        repository.runLoginAttempt(emailHash, WINDOW_MS, async (scope) => {
          await scope.writeAuditLog(failure(emailHash));
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await storedFailures(emailHash)).toBe(0);
    });

    it("does not report other database errors as unavailable", async () => {
      const emailHash = uniqueHash();

      const error = await repository
        .runLoginAttempt(emailHash, WINDOW_MS, async (scope) => {
          await scope.writeAuditLog({ ...failure(emailHash), ip: "not-an-ip" });
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(LoginAttemptUnavailableError);
      expect(await storedFailures(emailHash)).toBe(0);
    });

    /** PostgreSQL's current time, and a failed login backdated relative to it. */
    async function databaseNow() {
      const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      return row!.now;
    }
    const backdatedFailure = (emailHash: string, occurredAt: Date) =>
      prisma.auditLog.create({
        data: { action: "auth.login.failed", metadata: { emailHash }, occurredAt },
      });

    it("gives the attempt the time of its most recent failure inside the window (D3-3)", async () => {
      const emailHash = uniqueHash();
      const now = await databaseNow();
      await backdatedFailure(emailHash, new Date(now.getTime() - 20 * MINUTE_MS)); // outside
      const latest = new Date(now.getTime() - 5 * MINUTE_MS);
      await backdatedFailure(emailHash, new Date(now.getTime() - 10 * MINUTE_MS));
      await backdatedFailure(emailHash, latest);

      const seen = await repository.runLoginAttempt(emailHash, 15 * MINUTE_MS, async (scope) => ({
        failures: scope.recentFailures,
        lastFailureAt: scope.lastFailureAt,
      }));
      expect(seen.failures).toBe(2);
      expect(seen.lastFailureAt?.getTime()).toBe(latest.getTime());

      const none = await repository.runLoginAttempt(
        uniqueHash(),
        15 * MINUTE_MS,
        async (scope) => scope.lastFailureAt,
      );
      expect(none).toBeNull();
    });

    it("computes the delay and Retry-After on PostgreSQL time, whatever the API clock says (D3-3)", async () => {
      const email = uniqueEmail();
      await repository.createUser({
        email,
        passwordHash: await hashPassword(PASSWORD),
        fullName: "Integración",
      });
      const emailHash = createHash("sha256").update(email).digest("hex");
      const tenSecondsAgo = new Date((await databaseNow()).getTime() - 10_000);
      for (let i = 0; i < LIMIT; i++) await backdatedFailure(emailHash, tenSecondsAgo);

      // An API clock decades off must not change anything: only PostgreSQL time is used.
      const service = new AuthService({
        repository,
        isProduction: false,
        clock: () => new Date("2000-01-01T00:00:00Z"),
      });
      const blocked = await service
        .login(
          { email, password: PASSWORD },
          { ip: "203.0.113.7", userAgent: "integration-test", requestId: randomUUID() },
        )
        .catch((error: unknown) => error);

      expect(blocked).toBeInstanceOf(HttpError);
      expect((blocked as HttpError).statusCode).toBe(429);
      // 30 s from the last failure, 10 s already gone: about 20 s left.
      const retryAfter = Number((blocked as HttpError).headers?.["Retry-After"]);
      expect(retryAfter).toBeGreaterThanOrEqual(18);
      expect(retryAfter).toBeLessThanOrEqual(20);
    }, 20_000);

    const storedRefusals = (emailHash: string) =>
      prisma.auditLog.findMany({
        where: {
          action: "auth.login.rate_limited",
          metadata: { path: ["emailHash"], equals: emailHash },
        },
        orderBy: { occurredAt: "asc" },
      });

    it.each([
      ["an existing account", true],
      ["an unknown email", false],
    ])(
      "stores one auth.login.rate_limited per refusal for %s, dated on PostgreSQL time (D3-4)",
      async (_scenario, exists) => {
        const email = uniqueEmail();
        if (exists) {
          await repository.createUser({
            email,
            passwordHash: await hashPassword(PASSWORD),
            fullName: "Integración",
          });
        }
        const emailHash = createHash("sha256").update(email).digest("hex");
        const tenSecondsAgo = new Date((await databaseNow()).getTime() - 10_000);
        for (let i = 0; i < LIMIT; i++) await backdatedFailure(emailHash, tenSecondsAgo);
        const service = new AuthService({ repository, isProduction: false });

        const refusals: Array<{ requestId: string; retryAfter: number }> = [];
        for (let i = 0; i < 2; i++) {
          const requestId = randomUUID();
          const error = await service
            .login(
              { email, password: PASSWORD },
              { ip: "203.0.113.7", userAgent: "integration-test", requestId },
            )
            .catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(HttpError);
          expect((error as HttpError).statusCode).toBe(429);
          expect((error as HttpError).message).toBe("Demasiadas solicitudes. Inténtalo más tarde.");
          refusals.push({
            requestId,
            retryAfter: Number((error as HttpError).headers?.["Retry-After"]),
          });
        }

        const stored = await storedRefusals(emailHash);
        expect(stored).toHaveLength(2);
        stored.forEach((row, i) => {
          expect(row).toMatchObject({
            actorUserId: null,
            actorRole: null,
            entityType: null,
            entityId: null,
            previousValue: null,
            newValue: null,
            metadata: { emailHash, retryAfterSeconds: refusals[i]!.retryAfter },
            requestId: refusals[i]!.requestId,
            ip: "203.0.113.7",
            userAgent: "integration-test",
          });
          expect(Object.keys(row.metadata as object).sort()).toEqual([
            "emailHash",
            "retryAfterSeconds",
          ]);
          // Dated with the PostgreSQL time of its own attempt: 30 s after the last failure,
          // minus the Retry-After (rounded up) that the attempt computed.
          const elapsed = row.occurredAt.getTime() - tenSecondsAgo.getTime();
          expect(elapsed).toBeGreaterThanOrEqual(30_000 - refusals[i]!.retryAfter * 1_000);
          expect(elapsed).toBeLessThan(30_000 - (refusals[i]!.retryAfter - 1) * 1_000);
        });
        // The refusals do not count: still five failures.
        expect(await storedFailures(emailHash)).toBe(LIMIT);
      },
      20_000,
    );

    it("writes auth.login.rate_limited in the refusal's own transaction, dated with its now (D3-4)", async () => {
      const email = uniqueEmail();
      const emailHash = createHash("sha256").update(email).digest("hex");
      const tenSecondsAgo = new Date((await databaseNow()).getTime() - 10_000);
      for (let i = 0; i < LIMIT; i++) await backdatedFailure(emailHash, tenSecondsAgo);

      /** Records the attempt's `now`, and keeps its transaction open a little after the attempt. */
      class ObservedRepository extends PrismaAuthRepository {
        attemptNow: Date | null = null;
        override runLoginAttempt<T>(
          hash: string,
          windowMs: number,
          attempt: (scope: LoginAttemptScope) => Promise<T>,
        ): Promise<T> {
          return super.runLoginAttempt(hash, windowMs, async (scope) => {
            this.attemptNow = scope.now;
            const outcome = await attempt(scope);
            await sleep(200);
            return outcome;
          });
        }
      }
      const observed = new ObservedRepository(prisma);
      const service = new AuthService({ repository: observed, isProduction: false });

      await service
        .login(
          { email, password: PASSWORD },
          { ip: "203.0.113.7", userAgent: "integration-test", requestId: randomUUID() },
        )
        .catch(() => undefined);

      const [event] = await storedRefusals(emailHash);
      expect(observed.attemptNow).toBeInstanceOf(Date);
      // Written with the transaction's own PostgreSQL time: a write after the commit would be
      // dated at least 200 ms later.
      expect(event?.occurredAt.getTime()).toBe(observed.attemptNow!.getTime());
    }, 20_000);

    it("keeps no auth.login.rate_limited when the refusal's transaction expires (P2028) (D3-4)", async () => {
      const email = uniqueEmail();
      const emailHash = createHash("sha256").update(email).digest("hex");
      const tenSecondsAgo = new Date((await databaseNow()).getTime() - 10_000);
      for (let i = 0; i < LIMIT; i++) await backdatedFailure(emailHash, tenSecondsAgo);

      /** Lets the attempt write its event, then outlives the transaction's 5 s timeout. */
      class ExpiringRepository extends PrismaAuthRepository {
        override runLoginAttempt<T>(
          hash: string,
          windowMs: number,
          attempt: (scope: LoginAttemptScope) => Promise<T>,
        ): Promise<T> {
          return super.runLoginAttempt(hash, windowMs, async (scope) => {
            const outcome = await attempt(scope);
            await sleep(6_000);
            return outcome;
          });
        }
      }
      const service = new AuthService({
        repository: new ExpiringRepository(prisma),
        isProduction: false,
      });

      const error = await service
        .login(
          { email, password: PASSWORD },
          { ip: "203.0.113.7", userAgent: "integration-test", requestId: randomUUID() },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(503);
      expect(await storedRefusals(emailHash)).toHaveLength(0);
      expect(await storedFailures(emailHash)).toBe(LIMIT);
    }, 20_000);

    it("dates the failure with the PostgreSQL time read after the lock", async () => {
      const emailHash = uniqueHash();
      const requestId = randomUUID();

      const now = await repository.runLoginAttempt(emailHash, WINDOW_MS, async (scope) => {
        await scope.writeAuditLog(failure(emailHash, requestId));
        return scope.now;
      });

      const stored = await prisma.auditLog.findFirst({ where: { requestId } });
      expect(stored?.occurredAt.getTime()).toBe(now.getTime());
      const [row] = await prisma.$queryRaw<Array<{ skew: number }>>`
        SELECT abs(extract(epoch FROM (clock_timestamp() - ${now}::timestamptz)))::float8 AS skew`;
      expect(row!.skew).toBeLessThan(5);
    });
  });

  /**
   * ADR-002 D3 (S-3): only P2024, P2028 and P2010 with SQLSTATE 55P03 mean "cannot evaluate
   * the attempt" (503). Every other database error, including connection errors, stays a 500.
   * These tests inject a real database error inside the login attempt, after the service has
   * done its work and before the commit, and check the full HTTP answer.
   *
   * What each one proves:
   * - P2002 and P2010/22012 are raised through another connection (the shared `prisma` client),
   *   not the attempt's own. They exist to pin the error classification: a known Prisma error
   *   that is not P2024, P2028 or P2010/55P03 must stay a 500. They do not simulate losing the
   *   transaction's connection.
   * - P1017 does lose the attempt's own connection: it is terminated inside the transaction,
   *   so the commit fails.
   * - P1001 fails to establish a connection at all.
   */
  describe("login attempts: errors that must stay a 500 (ADR-002, D3)", () => {
    /** The real repository, with a real database error raised at the end of each attempt. */
    class FaultyAttemptRepository extends PrismaAuthRepository {
      private readonly fault: () => Promise<unknown>;

      constructor(client: PrismaClient, fault: () => Promise<unknown>) {
        super(client);
        this.fault = fault;
      }

      override runLoginAttempt<T>(
        emailHash: string,
        windowMs: number,
        attempt: Parameters<PrismaAuthRepository["runLoginAttempt"]>[2],
      ): Promise<T> {
        return super.runLoginAttempt(emailHash, windowMs, async (scope) => {
          const result = (await attempt(scope)) as T;
          await this.fault();
          return result;
        });
      }
    }

    function appWith(repository: PrismaAuthRepository) {
      return buildApp({
        env: TEST_ENV,
        health: { checkDatabase: async () => true },
        authService: new AuthService({ repository, isProduction: false }),
        casesService: new CasesService({ repository: new PrismaCasesRepository(prisma) }),
        documentsService: new DocumentsService({
          repository: new PrismaDocumentsRepository(prisma),
          cases: new PrismaCasesRepository(prisma),
          storage: new MemoryStorageProvider(),
          maxBytes: TEST_ENV.DOCUMENT_MAX_BYTES,
          downloadUrlTtlSeconds: TEST_ENV.DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
        }),
      });
    }

    async function userWithPassword() {
      const email = uniqueEmail();
      const user = await repository.createUser({
        email,
        passwordHash: await hashPassword(PASSWORD),
        fullName: "Integración",
      });
      return { email, user, emailHash: createHash("sha256").update(email).digest("hex") };
    }

    /**
     * A wrong password (its failure must be rolled back) and then the right one (the login must
     * not be granted): both must answer 500 INTERNAL_ERROR, never 503, and leave nothing behind.
     */
    async function expectInternalErrorAndNothingKept(
      fault: (context: { email: string }) => Promise<unknown>,
    ) {
      const { email, user, emailHash } = await userWithPassword();
      const app = await appWith(new FaultyAttemptRepository(prisma, () => fault({ email })));
      try {
        for (const password of ["wrong password entirely", PASSWORD]) {
          const response = await app.inject({
            method: "POST",
            url: "/api/auth/login",
            headers: { origin: TEST_ENV.APP_ORIGIN, "content-type": "application/json" },
            payload: { email, password },
          });
          expect(response.statusCode).toBe(500);
          expect(response.json().error.code).toBe("INTERNAL_ERROR");
          expect(response.headers["retry-after"]).toBeUndefined();
          expect(response.headers["set-cookie"]).toBeUndefined();
        }
      } finally {
        await app.close();
      }
      expect(
        await prisma.auditLog.count({
          where: {
            action: "auth.login.failed",
            metadata: { path: ["emailHash"], equals: emailHash },
          },
        }),
      ).toBe(0);
      expect(
        await prisma.auditLog.count({ where: { action: "auth.login.success", entityId: user.id } }),
      ).toBe(0);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    }

    it("keeps a unique violation (P2002) raised during the attempt a 500, and rolls it back", async () => {
      // Raised through another connection, to pin the classification (see above).
      await expectInternalErrorAndNothingKept(({ email }) =>
        prisma.user.create({ data: { email, passwordHash: "x", fullName: "Duplicado" } }),
      );
    }, 30_000);

    it("keeps a raw-query error with another SQLSTATE (P2010, 22012) a 500, and rolls it back", async () => {
      // Raised through another connection, to pin the classification (see above).
      await expectInternalErrorAndNothingKept(() => prisma.$executeRaw`SELECT 1 / 0`);
    }, 30_000);

    it("keeps a connection closed during the transaction (P1017) a 500, and rolls it back", async () => {
      const killer = createPrismaClient(databaseUrl!);
      try {
        await expectInternalErrorAndNothingKept(async () => {
          // The attempt's own connection is the one idle inside its transaction: close it, so
          // the commit fails with P1017 and PostgreSQL rolls the transaction back.
          await killer.$executeRaw`
            SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE usename = current_user AND state = 'idle in transaction' AND pid <> pg_backend_pid()`;
          await new Promise((resolve) => setTimeout(resolve, 200));
        });
      } finally {
        await killer.$disconnect();
      }
    }, 30_000);

    // No connection can be established, so nothing can be written and there is no transaction to
    // roll back: the test checks only what an unreachable database can show (the HTTP answer).
    it("keeps an unreachable database (P1001) a 500", async () => {
      const unreachable = createPrismaClient("postgresql://legaltech_app:x@127.0.0.1:1/legaltech");
      const app = await appWith(new PrismaAuthRepository(unreachable));
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: TEST_ENV.APP_ORIGIN, "content-type": "application/json" },
          payload: { email: uniqueEmail(), password: PASSWORD },
        });
        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe("INTERNAL_ERROR");
        expect(response.headers["retry-after"]).toBeUndefined();
        expect(response.headers["set-cookie"]).toBeUndefined();
      } finally {
        await app.close();
        await unreachable.$disconnect();
      }
    }, 30_000);
  });
});
