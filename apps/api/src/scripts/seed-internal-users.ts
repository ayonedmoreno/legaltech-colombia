import type { Role } from "@legaltech/database";
import type { AuditLogEntry } from "../modules/auth/auth.types.js";

/**
 * Development seed for internal accounts (ADR-003: PROFESSIONAL, ADMIN and SUPER_ADMIN are never
 * created by public registration, only by a controlled mechanism — this script for development,
 * an administrative flow later). It refuses to run unless NODE_ENV is explicitly `development`
 * or `test`, takes the password from the environment (never from the repository), never
 * modifies an existing account, and audits every account it creates.
 */

type InternalRole = Exclude<Role, "USER">;

export interface SeedAccount {
  email: string;
  fullName: string;
  role: InternalRole;
}

/** `.test` is a reserved TLD (RFC 2606): these addresses can never belong to a real person. */
export const INTERNAL_SEED_ACCOUNTS: readonly SeedAccount[] = [
  {
    email: "professional@legaltech.test",
    fullName: "Profesional (desarrollo)",
    role: "PROFESSIONAL",
  },
  { email: "admin@legaltech.test", fullName: "Administrador (desarrollo)", role: "ADMIN" },
  {
    email: "superadmin@legaltech.test",
    fullName: "Superadministrador (desarrollo)",
    role: "SUPER_ADMIN",
  },
];

export const SEED_AUDIT_ACTION = "user.seeded";

export interface SeedStore {
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  createInternalUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    role: InternalRole;
  }): Promise<{ id: string }>;
  writeAuditLog(entry: AuditLogEntry): Promise<void>;
}

export interface SeedResult {
  created: SeedAccount[];
  skipped: SeedAccount[];
}

/**
 * Throws unless the raw NODE_ENV is explicitly development or test. The raw value is used on
 * purpose: a missing NODE_ENV must not be treated as development here.
 */
export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error(
      "The internal-accounts seed only runs with NODE_ENV=development or NODE_ENV=test.",
    );
  }
}

/** Same bounds as registration (ADR-002: 12 to 128 characters). */
export function assertSeedPassword(password: string | undefined): string {
  if (!password || password.length < 12 || password.length > 128) {
    throw new Error("SEED_INTERNAL_PASSWORD must be set, with 12 to 128 characters.");
  }
  return password;
}

export async function seedInternalUsers(
  store: SeedStore,
  password: string,
  hashPassword: (password: string) => Promise<string>,
  accounts: readonly SeedAccount[] = INTERNAL_SEED_ACCOUNTS,
): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };

  for (const account of accounts) {
    // Never touch an existing account: no silent role or password change.
    if (await store.findUserByEmail(account.email)) {
      result.skipped.push(account);
      continue;
    }

    const user = await store.createInternalUser({
      email: account.email,
      passwordHash: await hashPassword(password),
      fullName: account.fullName,
      role: account.role,
    });

    await store.writeAuditLog({
      actorUserId: null,
      actorRole: null,
      action: SEED_AUDIT_ACTION,
      entityType: "User",
      entityId: user.id,
      metadata: { role: account.role },
      requestId: null,
      ip: null,
      userAgent: null,
    });
    result.created.push(account);
  }

  return result;
}
