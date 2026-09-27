import type { EmailOutboxKind } from "@legaltech/database";

/**
 * Email outbox (ARCHITECTURE_REPORT: "Notificaciones: patrón outbox, email primero"; Sprint 1B
 * decision C2). An operation that must send an email records only the intent — its kind and
 * the user — in the same transaction as the change that caused it. A dispatcher later turns
 * each pending intent into a message and hands it to an `EmailTransport`. A token an email
 * carries is generated at dispatch time, in memory; only its hash is stored (ADR-002), and the
 * outbox never holds any secret.
 *
 * In Sprint 1B the dispatcher is invoked by tests and by a development command; the worker of
 * Phase 3 (ADR-001) will invoke the same function, with a real transport.
 */

/** A message ready to be delivered. Transports must never log `text`: it may carry a token. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Delivers messages (ADR-001: providers live behind interfaces). */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/** A pending intent, as stored in `email_outbox`. */
export interface OutboxEntry {
  id: string;
  kind: EmailOutboxKind;
  userId: string;
  createdAt: Date;
}

/** What a composer may use while its entry is being dispatched, inside that entry's transaction. */
export interface OutboxDispatchScope {
  /** PostgreSQL time of the dispatch transaction. */
  now: Date;
  /** The recipient's address, or null if the user no longer exists. */
  findUserEmail(userId: string): Promise<string | null>;
  /**
   * Stores the hash of a new email verification token for the user and invalidates the user's
   * earlier unused ones (Sprint 1B decision P7), in the dispatch transaction: if the email is
   * not sent, neither change is kept.
   */
  replaceEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** The same for a password reset token (ADR-002 "Recuperación segura"; decision P7). */
  replacePasswordResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
}

/** Builds the message for one entry. Throwing leaves the entry pending. */
export type EmailComposer = (
  entry: OutboxEntry,
  scope: OutboxDispatchScope,
) => Promise<EmailMessage>;

/** The composer for each kind of email; a kind without one is left pending. */
export type EmailComposers = Partial<Record<EmailOutboxKind, EmailComposer>>;

export interface OutboxRepository {
  /**
   * Hands the oldest pending entry not listed in `exclude` to `handle` and marks it sent, all in
   * one transaction. Entries another dispatcher is handling are skipped, never handled twice. If
   * `handle` throws, the transaction is rolled back: the entry stays pending and the error
   * propagates. Returns false when there is no entry left to handle.
   */
  dispatchNext(
    exclude: readonly string[],
    handle: (entry: OutboxEntry, scope: OutboxDispatchScope) => Promise<void>,
  ): Promise<boolean>;
}
