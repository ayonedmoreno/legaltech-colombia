import { describe, expect, it } from "vitest";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import { createSessionForUser, loadValidSession } from "./auth.session.js";

async function seedUser(repository: FakeAuthRepository) {
  return repository.createUser({ email: "ana@example.com", passwordHash: "x", fullName: "Ana" });
}

describe("session lifecycle", () => {
  it("loads a freshly created session as valid and slides the idle window", async () => {
    const repository = new FakeAuthRepository();
    const user = await seedUser(repository);
    let now = new Date("2026-01-01T00:00:00Z");
    const clock = () => now;

    const created = await createSessionForUser(
      repository,
      user,
      { ip: null, userAgent: null },
      clock,
    );

    now = new Date(now.getTime() + 60_000);
    const loaded = await loadValidSession(repository, created.sessionRaw, clock);

    expect(loaded).not.toBeNull();
    expect(loaded!.session.id).toBe(created.session.id);
    expect(loaded!.session.lastSeenAt.getTime()).toBe(now.getTime());
  });

  it("returns null for a token that does not match any session", async () => {
    const repository = new FakeAuthRepository();
    expect(await loadValidSession(repository, "not-a-real-token")).toBeNull();
  });

  it("returns null for a revoked session", async () => {
    const repository = new FakeAuthRepository();
    const user = await seedUser(repository);
    const created = await createSessionForUser(repository, user, { ip: null, userAgent: null });

    await repository.revokeSession(created.session.id, "LOGOUT");

    expect(await loadValidSession(repository, created.sessionRaw)).toBeNull();
  });

  it("returns null once the idle window has elapsed without activity", async () => {
    const repository = new FakeAuthRepository();
    const user = await seedUser(repository);
    let now = new Date("2026-01-01T00:00:00Z");
    const clock = () => now;
    // USER idle window is 7 days.
    const created = await createSessionForUser(
      repository,
      user,
      { ip: null, userAgent: null },
      clock,
    );

    now = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(await loadValidSession(repository, created.sessionRaw, clock)).toBeNull();
  });

  it("returns null once the absolute lifetime has elapsed, even with recent activity", async () => {
    const repository = new FakeAuthRepository();
    const user = await seedUser(repository);
    let now = new Date("2026-01-01T00:00:00Z");
    const clock = () => now;
    // USER absolute lifetime is 30 days.
    const created = await createSessionForUser(
      repository,
      user,
      { ip: null, userAgent: null },
      clock,
    );

    // Touch the session every 2 days (well within the 7-day idle window each time) until
    // the absolute lifetime is exceeded, to prove the absolute expiry is a hard ceiling
    // that sliding activity cannot extend.
    for (let day = 2; day <= 30; day += 2) {
      now = new Date(new Date("2026-01-01T00:00:00Z").getTime() + day * 24 * 60 * 60 * 1000);
      await loadValidSession(repository, created.sessionRaw, clock);
    }

    now = new Date(new Date("2026-01-01T00:00:00Z").getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await loadValidSession(repository, created.sessionRaw, clock)).toBeNull();
  });
});
