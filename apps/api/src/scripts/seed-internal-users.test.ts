import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuditLogEntry } from "../modules/auth/auth.types.js";
import { hashPassword, verifyPassword } from "../security/password.js";
import {
  INTERNAL_SEED_ACCOUNTS,
  SEED_AUDIT_ACTION,
  assertSeedAllowed,
  assertSeedPassword,
  seedInternalUsers,
  type SeedStore,
} from "./seed-internal-users.js";

const PASSWORD = "dev-only seed password";

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: string;
}

function memoryStore(existing: StoredUser[] = []) {
  const users = [...existing];
  const auditLog: AuditLogEntry[] = [];
  const store: SeedStore = {
    findUserByEmail: async (email) => users.find((user) => user.email === email) ?? null,
    createInternalUser: async (input) => {
      const user = { id: randomUUID(), ...input };
      users.push(user);
      return { id: user.id };
    },
    writeAuditLog: async (entry) => {
      auditLog.push(entry);
    },
  };
  return { store, users, auditLog };
}

describe("seed of internal accounts (ADR-003)", () => {
  it("creates one PROFESSIONAL, ADMIN and SUPER_ADMIN account with Argon2id hashes", async () => {
    const { store, users } = memoryStore();

    const result = await seedInternalUsers(store, PASSWORD, hashPassword);

    expect(result.created.map((account) => account.role)).toEqual([
      "PROFESSIONAL",
      "ADMIN",
      "SUPER_ADMIN",
    ]);
    expect(users.map(({ email, role }) => ({ email, role }))).toEqual(
      INTERNAL_SEED_ACCOUNTS.map(({ email, role }) => ({ email, role })),
    );
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
    }
  });

  it("uses only reserved .test addresses and never the USER role", () => {
    for (const account of INTERNAL_SEED_ACCOUNTS) {
      expect(account.email).toMatch(/@legaltech\.test$/);
      expect(account.role).not.toBe("USER");
    }
  });

  it("audits every created account without secrets", async () => {
    const { store, users, auditLog } = memoryStore();
    await seedInternalUsers(store, PASSWORD, hashPassword);

    expect(auditLog).toHaveLength(3);
    for (const [index, entry] of auditLog.entries()) {
      expect(entry).toMatchObject({
        action: SEED_AUDIT_ACTION,
        entityType: "User",
        entityId: users[index]!.id,
        metadata: { role: users[index]!.role },
      });
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain("$argon2id$");
    }
  });

  it("is idempotent and never modifies an existing account", async () => {
    const existing: StoredUser = {
      id: randomUUID(),
      email: "admin@legaltech.test",
      passwordHash: "untouched-hash",
      fullName: "Cuenta previa",
      role: "USER",
    };
    const { store, users, auditLog } = memoryStore([existing]);

    const first = await seedInternalUsers(store, PASSWORD, hashPassword);
    const second = await seedInternalUsers(store, PASSWORD, hashPassword);

    expect(first.skipped.map((account) => account.email)).toEqual(["admin@legaltech.test"]);
    expect(second.created).toEqual([]);
    expect(users).toHaveLength(3);
    expect(users.find((user) => user.id === existing.id)).toEqual(existing);
    expect(auditLog).toHaveLength(2);
  });
});

describe("seed guards", () => {
  it.each(["development", "test"])("allows NODE_ENV=%s", (nodeEnv) => {
    expect(() => assertSeedAllowed(nodeEnv)).not.toThrow();
  });

  it.each([undefined, "", "production", "staging", "Development"])(
    "refuses NODE_ENV=%s (fail closed: a missing value is not development)",
    (nodeEnv) => {
      expect(() => assertSeedAllowed(nodeEnv)).toThrow(/only runs with NODE_ENV=development/);
    },
  );

  it.each([undefined, "", "short", "x".repeat(129)])(
    "rejects an unset or out-of-bounds password",
    (password) => {
      expect(() => assertSeedPassword(password)).toThrow(/SEED_INTERNAL_PASSWORD/);
    },
  );

  it("accepts a password of 12 to 128 characters", () => {
    expect(assertSeedPassword(PASSWORD)).toBe(PASSWORD);
  });
});
