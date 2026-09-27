import type { EmailComposers, EmailTransport, OutboxRepository } from "./notifications.types.js";

export interface DispatchResult {
  sent: number;
  failed: number;
}

/**
 * Dispatches pending outbox entries (Sprint 1B decision C2/P2): for each one, its kind's composer
 * builds the message and the transport delivers it; the entry is then marked sent in the same
 * transaction. An entry whose composer is missing or whose composer or transport fails stays
 * pending and is not tried again in this run, so one broken entry never blocks the others. At
 * most `limit` entries are handled per run. Errors are counted, never logged: a message may
 * carry a token.
 *
 * A pure function of its dependencies: tests and the development command call it now; the
 * Phase 3 worker (ADR-001) will call it unchanged.
 */
export async function dispatchPendingEmails(
  repository: OutboxRepository,
  transport: EmailTransport,
  composers: EmailComposers,
  options: { limit?: number } = {},
): Promise<DispatchResult> {
  const limit = options.limit ?? 100;
  const attempted: string[] = [];
  const result: DispatchResult = { sent: 0, failed: 0 };

  while (result.sent + result.failed < limit) {
    try {
      const handled = await repository.dispatchNext(attempted, async (entry, scope) => {
        attempted.push(entry.id);
        const composer = composers[entry.kind];
        if (!composer) throw new Error("no composer for this kind of email");
        await transport.send(await composer(entry, scope));
      });
      if (!handled) break;
      result.sent += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * The development dispatch command only runs with NODE_ENV explicitly `development` or `test`
 * (the raw value, as for the seed): in production, dispatch belongs to the Phase 3 worker.
 */
export function assertDispatchAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("The email dispatch command only runs with NODE_ENV=development or test.");
  }
}
