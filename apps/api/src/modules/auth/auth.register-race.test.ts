import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";
import { FakeAuthRepository } from "./auth.repository.fake.js";
import type { UserRecord } from "./auth.types.js";

const ORIGIN = "http://localhost:3000";

/**
 * Reproduces the race deterministically: the first two email lookups are held until both
 * have run, so both registrations see "no such user" before either inserts. The losing
 * insert then hits the unique constraint (DuplicateEmailError, as PrismaAuthRepository
 * maps P2002).
 */
class RacingRepository extends FakeAuthRepository {
  private readonly heldLookups: Array<() => void> = [];

  override async findUserByEmail(email: string): Promise<UserRecord | null> {
    const result = await super.findUserByEmail(email);
    if (this.heldLookups.length < 2) {
      await new Promise<void>((release) => {
        this.heldLookups.push(release);
        if (this.heldLookups.length === 2) this.heldLookups.forEach((held) => held());
      });
    }
    return result;
  }
}

describe("POST /api/auth/register — concurrent registrations for the same email", () => {
  it("creates one account and answers both requests with the identical 202, never 500", async () => {
    const repository = new RacingRepository();
    const { app } = await buildTestApp({ repository });
    const register = (fullName: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        payload: { email: "ana@example.com", password: "correct horse battery", fullName },
      });

    const [first, second] = await Promise.all([register("Ana Gómez"), register("Otra Persona")]);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toBe(first.body);
    expect(repository.users.size).toBe(1);

    const [user] = [...repository.users.values()];
    const outcomes = repository.auditLog
      .filter((entry) => entry.action === "auth.register")
      .map((entry) => ({ outcome: entry.metadata?.outcome, entityId: entry.entityId }));
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { outcome: "created", entityId: user!.id },
        { outcome: "duplicate", entityId: user!.id },
      ]),
    );
    expect(outcomes).toHaveLength(2);
    await app.close();
  });
});
