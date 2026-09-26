import { createPrismaClient, type Prisma } from "@legaltech/database";
import { hashPassword } from "../security/password.js";
import {
  assertSeedAllowed,
  assertSeedPassword,
  seedInternalUsers,
  type SeedStore,
} from "./seed-internal-users.js";

/**
 * `pnpm db:seed`: creates the development internal accounts (see seed-internal-users.ts).
 * Uses the runtime application role (DATABASE_URL), which may insert users and audit events.
 */
assertSeedAllowed(process.env.NODE_ENV);
const password = assertSeedPassword(process.env.SEED_INTERNAL_PASSWORD);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set.");

const prisma = createPrismaClient(databaseUrl);

const store: SeedStore = {
  findUserByEmail: (email) => prisma.user.findUnique({ where: { email }, select: { id: true } }),
  createInternalUser: (input) => prisma.user.create({ data: input, select: { id: true } }),
  writeAuditLog: async (entry) => {
    await prisma.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        actorRole: entry.actorRole,
        action: entry.action,
        entityType: entry.entityType ?? undefined,
        entityId: entry.entityId ?? undefined,
        metadata: entry.metadata as Prisma.InputJsonObject | undefined,
        requestId: entry.requestId,
        ip: entry.ip,
        userAgent: entry.userAgent,
      },
    });
  },
};

try {
  const { created, skipped } = await seedInternalUsers(store, password, hashPassword);
  // The password is never printed.
  for (const account of created)
    console.log(`created  ${account.role.padEnd(12)} ${account.email}`);
  for (const account of skipped)
    console.log(`exists   ${account.role.padEnd(12)} ${account.email} (unchanged)`);
} finally {
  await prisma.$disconnect();
}
