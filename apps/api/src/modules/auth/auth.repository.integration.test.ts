import { createHash, randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaAuthRepository } from "./auth.repository.js";
import { DuplicateEmailError, type CreateSessionInput } from "./auth.types.js";

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

    it("countRecentFailedLogins counts only failed logins for that email hash (JSON filter)", async () => {
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

      const since = new Date(Date.now() - 5 * MINUTE_MS);
      expect(await repository.countRecentFailedLogins(target, since)).toBe(3);
      expect(await repository.countRecentFailedLogins(other, since)).toBe(1);
      expect(await repository.countRecentFailedLogins(uniqueHash(), since)).toBe(0);
    });

    it("countRecentFailedLogins only counts events inside the time window", async () => {
      const target = uniqueHash();
      await failedLogin(target, new Date(Date.now() - 20 * MINUTE_MS));
      await failedLogin(target);

      expect(
        await repository.countRecentFailedLogins(target, new Date(Date.now() - 15 * MINUTE_MS)),
      ).toBe(1);
      expect(
        await repository.countRecentFailedLogins(target, new Date(Date.now() - 30 * MINUTE_MS)),
      ).toBe(2);
      expect(
        await repository.countRecentFailedLogins(target, new Date(Date.now() + 5 * MINUTE_MS)),
      ).toBe(0);
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
});
