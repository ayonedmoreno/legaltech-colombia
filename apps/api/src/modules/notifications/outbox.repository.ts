import type { EmailOutboxKind, Prisma, PrismaClient } from "@legaltech/database";
import type { OutboxDispatchScope, OutboxEntry, OutboxRepository } from "./notifications.types.js";

/**
 * Records the intent to send an email. Pass the transaction client of the operation that causes
 * the email, so the intent commits together with that change, or not at all (outbox pattern).
 */
export async function enqueueEmail(
  client: Pick<Prisma.TransactionClient, "emailOutbox">,
  kind: EmailOutboxKind,
  userId: string,
): Promise<void> {
  await client.emailOutbox.create({ data: { kind, userId } });
}

/** Prisma-backed outbox (ARCHITECTURE_REPORT outbox pattern; Sprint 1B decision C2). */
export class PrismaOutboxRepository implements OutboxRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async dispatchNext(
    exclude: readonly string[],
    handle: (entry: OutboxEntry, scope: OutboxDispatchScope) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // SKIP LOCKED: an entry another dispatcher holds is skipped, so none is handled twice.
      const [row] = await tx.$queryRaw<
        Array<{ id: string; kind: EmailOutboxKind; user_id: string; created_at: Date; now: Date }>
      >`
        SELECT id, kind, user_id, created_at, clock_timestamp() AS now
        FROM email_outbox
        WHERE sent_at IS NULL AND NOT (id = ANY(${[...exclude]}::uuid[]))
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      if (!row) return false;

      await handle(
        { id: row.id, kind: row.kind, userId: row.user_id, createdAt: row.created_at },
        {
          now: row.now,
          findUserEmail: async (userId) =>
            (await tx.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ??
            null,
          replaceEmailVerificationToken: async (userId, tokenHash, expiresAt) => {
            await tx.emailVerificationToken.updateMany({
              where: { userId, usedAt: null },
              data: { usedAt: row.now },
            });
            await tx.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } });
          },
          replacePasswordResetToken: async (userId, tokenHash, expiresAt) => {
            await tx.passwordResetToken.updateMany({
              where: { userId, usedAt: null },
              data: { usedAt: row.now },
            });
            await tx.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });
          },
        },
      );
      await tx.emailOutbox.update({ where: { id: row.id }, data: { sentAt: row.now } });
      return true;
    });
  }
}
