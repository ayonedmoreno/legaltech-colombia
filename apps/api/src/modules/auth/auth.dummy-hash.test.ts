import { hash, verify } from "@node-rs/argon2";
import { describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test-support/build-test-app.js";

// Wraps the real Argon2 bindings (below security/password.ts) so the hash computed inside
// dummyPasswordHash() is counted too. Kept in its own file: vitest isolates modules per
// file, so the per-process dummy hash starts out not yet computed, as in a fresh server.
vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...actual, hash: vi.fn(actual.hash), verify: vi.fn(actual.verify) };
});

const ORIGIN = "http://localhost:3000";

function loginUnknownEmail(app: Awaited<ReturnType<typeof buildTestApp>>["app"]) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: { email: "nobody@example.com", password: "correct horse battery" },
  });
}

describe("dummy Argon2id hash for unknown-email logins", () => {
  it("is computed while the app starts, so the first login does not have to generate it", async () => {
    expect(vi.mocked(hash)).not.toHaveBeenCalled();

    const { app } = await buildTestApp();
    expect(vi.mocked(hash)).toHaveBeenCalledTimes(1);

    vi.mocked(hash).mockClear();
    vi.mocked(verify).mockClear();
    const first = await loginUnknownEmail(app);

    expect(first.statusCode).toBe(401);
    expect(vi.mocked(hash)).not.toHaveBeenCalled();
    expect(vi.mocked(verify)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("is a production-cost Argon2id hash, reused for every unknown email", async () => {
    const { app } = await buildTestApp();
    vi.mocked(hash).mockClear();
    vi.mocked(verify).mockClear();

    await loginUnknownEmail(app);
    await loginUnknownEmail(app);

    expect(vi.mocked(hash)).not.toHaveBeenCalled();
    const [firstHash, secondHash] = vi.mocked(verify).mock.calls.map((call) => call[0]);
    expect(firstHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(secondHash).toBe(firstHash);
    await app.close();
  });
});
