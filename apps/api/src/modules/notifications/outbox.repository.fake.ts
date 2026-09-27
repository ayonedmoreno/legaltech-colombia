import { randomUUID } from "node:crypto";
import type { EmailOutboxKind } from "@legaltech/database";
import type { OutboxDispatchScope, OutboxEntry, OutboxRepository } from "./notifications.types.js";

interface StoredEntry extends OutboxEntry {
  sentAt: Date | null;
}

/** A verification or password reset token as stored: only its hash (ADR-002). */
export interface StoredToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/** Invalidates the user's unused tokens in `tokens` and adds the new one (decision P7). */
function replaceToken(
  tokens: StoredToken[],
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  now: Date,
): void {
  for (const token of tokens) {
    if (token.userId === userId && token.usedAt === null) token.usedAt = now;
  }
  tokens.push({ userId, tokenHash, expiresAt, usedAt: null, createdAt: now });
}

/**
 * In-memory outbox used by tests. Mirrors PrismaOutboxRepository: the oldest pending entry is
 * handled first, and the entry is marked sent — and the token changes made while handling it
 * are kept — only if `handle` completes (the transaction commits).
 */
export class FakeOutboxRepository implements OutboxRepository {
  readonly entries: StoredEntry[] = [];
  readonly emailVerificationTokens: StoredToken[] = [];
  readonly passwordResetTokens: StoredToken[] = [];
  readonly userEmails = new Map<string, string>();
  clock: () => Date = () => new Date();
  /** Where recipients' addresses come from; FakeAuthRepository points it at its users. */
  userEmailLookup: (userId: string) => string | null = (userId) =>
    this.userEmails.get(userId) ?? null;

  enqueue(kind: EmailOutboxKind, userId: string): OutboxEntry {
    const entry: StoredEntry = {
      id: randomUUID(),
      kind,
      userId,
      createdAt: this.clock(),
      sentAt: null,
    };
    this.entries.push(entry);
    return { id: entry.id, kind, userId, createdAt: entry.createdAt };
  }

  async dispatchNext(
    exclude: readonly string[],
    handle: (entry: OutboxEntry, scope: OutboxDispatchScope) => Promise<void>,
  ): Promise<boolean> {
    const entry = this.entries
      .filter((e) => e.sentAt === null && !exclude.includes(e.id))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
    if (!entry) return false;

    const now = this.clock();
    const pending: Array<() => void> = [];
    await handle(
      { id: entry.id, kind: entry.kind, userId: entry.userId, createdAt: entry.createdAt },
      {
        now,
        findUserEmail: async (userId) => this.userEmailLookup(userId),
        replaceEmailVerificationToken: async (userId, tokenHash, expiresAt) => {
          pending.push(() =>
            replaceToken(this.emailVerificationTokens, userId, tokenHash, expiresAt, now),
          );
        },
        replacePasswordResetToken: async (userId, tokenHash, expiresAt) => {
          pending.push(() =>
            replaceToken(this.passwordResetTokens, userId, tokenHash, expiresAt, now),
          );
        },
      },
    );
    for (const apply of pending) apply();
    entry.sentAt = now;
    return true;
  }
}
