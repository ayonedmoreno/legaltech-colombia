import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../security/crypto.js";
import { PrismaAuthRepository } from "./auth.repository.js";
import {
  loadValidSession,
  rotateSessionForUser,
  SESSION_ROTATION_GRACE_MS,
} from "./auth.session.js";
import type { CreateSessionInput } from "./auth.types.js";

/**
 * Session rotation against real PostgreSQL, as the application role (Sprint 1B, D7).
 * Opt-in: runs only with INTEGRATION_DATABASE_URL.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const MINUTE_MS = 60 * 1000;

describe.skipIf(!databaseUrl)("session rotation (PostgreSQL integration)", () => {
  let prisma: PrismaClient;
  let repository: PrismaAuthRepository;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
    repository = new PrismaAuthRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const newUser = () =>
    repository.createUser({
      email: `rotate-${randomUUID()}@example.com`,
      passwordHash: "$argon2id$integration-test-placeholder",
      fullName: "Integración",
    });

  function sessionInput(userId: string, createdAt: Date): CreateSessionInput {
    return {
      userId,
      tokenHash: sha256Hex(randomUUID()),
      csrfTokenHash: sha256Hex(randomUUID()),
      createdAt,
      lastSeenAt: createdAt,
      idleExpiresAt: new Date(createdAt.getTime() + 60 * MINUTE_MS),
      absoluteExpiresAt: new Date(createdAt.getTime() + 24 * 60 * MINUTE_MS),
      ip: "203.0.113.7",
      userAgent: "integration-test",
    };
  }

  it("rotates once under concurrency, keeps the absolute expiry, and honours the grace period", async () => {
    const user = await newUser();
    const start = new Date();
    const previous = await repository.createSession(sessionInput(user.id, start));
    expect(previous.createdAt.getTime()).toBe(start.getTime());
    // Inside the 60-minute idle window: only the rotation keeps the previous session out of lists.
    const later = new Date(start.getTime() + 30 * MINUTE_MS);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        rotateSessionForUser(
          repository,
          previous,
          user,
          { ip: null, userAgent: null },
          () => later,
        ),
      ),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const renewed = winners[0]!;
    expect(renewed.session.absoluteExpiresAt.getTime()).toBe(previous.absoluteExpiresAt.getTime());
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);

    const stored = await prisma.session.findUnique({ where: { id: previous.id } });
    expect(stored?.rotatedAt?.getTime()).toBe(later.getTime());
    expect(stored?.revokedAt).toBeNull();

    // Only the renewed session is listed, even while the previous one is in its grace period.
    const withinGrace = new Date(later.getTime() + SESSION_ROTATION_GRACE_MS - 1);
    const listed = await repository.listActiveSessions(user.id, withinGrace);
    expect(listed.map((s) => s.id)).toEqual([renewed.session.id]);
  });

  it("validates a rotated session by its real token only during the grace period", async () => {
    const user = await newUser();
    const start = new Date();
    const raw = randomUUID();
    const input = { ...sessionInput(user.id, start), tokenHash: sha256Hex(raw) };
    const previous = await repository.createSession(input);
    // Within its 60-minute idle window, so only the grace period decides.
    const rotatedAt = new Date(start.getTime() + 30 * MINUTE_MS);
    await rotateSessionForUser(
      repository,
      previous,
      user,
      { ip: null, userAgent: null },
      () => rotatedAt,
    );

    const inGrace = await loadValidSession(
      repository,
      raw,
      () => new Date(rotatedAt.getTime() + SESSION_ROTATION_GRACE_MS - 1),
    );
    expect(inGrace?.session.id).toBe(previous.id);
    const expired = await loadValidSession(
      repository,
      raw,
      () => new Date(rotatedAt.getTime() + SESSION_ROTATION_GRACE_MS),
    );
    expect(expired).toBeNull();
  });

  it("revokes, with ROTATED, the user's sessions whose grace period ended — nobody else's", async () => {
    const user = await newUser();
    const other = await newUser();
    const start = new Date();
    const first = await repository.createSession(sessionInput(user.id, start));
    const t1 = new Date(start.getTime() + 60 * MINUTE_MS);
    const second = await rotateSessionForUser(
      repository,
      first,
      user,
      { ip: null, userAgent: null },
      () => t1,
    );
    const otherSession = await repository.createSession(sessionInput(other.id, start));
    await prisma.session.update({ where: { id: otherSession.id }, data: { rotatedAt: start } });
    const t2 = new Date(t1.getTime() + 60 * MINUTE_MS);

    await rotateSessionForUser(
      repository,
      second!.session,
      user,
      { ip: null, userAgent: null },
      () => t2,
    );

    const firstStored = await prisma.session.findUnique({ where: { id: first.id } });
    expect(firstStored?.revokedReason).toBe("ROTATED");
    expect(firstStored?.revokedAt?.getTime()).toBe(t2.getTime());
    const secondStored = await prisma.session.findUnique({ where: { id: second!.session.id } });
    expect(secondStored?.rotatedAt?.getTime()).toBe(t2.getTime());
    expect(secondStored?.revokedAt).toBeNull(); // its own grace period has just started
    expect(
      (await prisma.session.findUnique({ where: { id: otherSession.id } }))?.revokedAt,
    ).toBeNull();
  });

  it("does not rotate a revoked or another user's session", async () => {
    const user = await newUser();
    const other = await newUser();
    const start = new Date();
    const later = new Date(start.getTime() + 60 * MINUTE_MS);
    const revoked = await repository.createSession(sessionInput(user.id, start));
    await repository.revokeSession(revoked.id, "LOGOUT");
    const foreign = await repository.createSession(sessionInput(other.id, start));

    expect(
      await rotateSessionForUser(
        repository,
        { ...revoked, revokedAt: null },
        user,
        { ip: null, userAgent: null },
        () => later,
      ),
    ).toBeNull();
    expect(
      await rotateSessionForUser(
        repository,
        foreign,
        user,
        { ip: null, userAgent: null },
        () => later,
      ),
    ).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await prisma.session.findUnique({ where: { id: foreign.id } }))?.rotatedAt).toBeNull();
  });
});
