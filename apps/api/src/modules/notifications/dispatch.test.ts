import { describe, expect, it } from "vitest";
import { assertDispatchAllowed, dispatchPendingEmails } from "./dispatch.js";
import type { EmailComposer, EmailMessage } from "./notifications.types.js";
import { FakeOutboxRepository } from "./outbox.repository.fake.js";
import { MemoryEmailTransport } from "./transports.js";

/**
 * dispatchPendingEmails (Sprint 1B decisions C2/P2): pending intents become messages through
 * their kind's composer, are delivered by the transport, and are marked sent only then.
 */
function setup() {
  let now = new Date("2026-03-01T12:00:00.000Z");
  const repository = new FakeOutboxRepository();
  repository.clock = () => now;
  repository.userEmails.set("user-1", "ana@example.com");
  repository.userEmails.set("user-2", "luis@example.com");
  const transport = new MemoryEmailTransport();
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { repository, transport, advance };
}

const verification: EmailComposer = async (entry, scope) => ({
  to: (await scope.findUserEmail(entry.userId))!,
  subject: "Verifica tu correo",
  text: `entry ${entry.id}`,
});

describe("dispatchPendingEmails", () => {
  it("sends each pending entry once, oldest first, and marks it sent", async () => {
    const { repository, transport, advance } = setup();
    const first = repository.enqueue("EMAIL_VERIFICATION", "user-1");
    advance(1_000);
    const second = repository.enqueue("EMAIL_VERIFICATION", "user-2");

    const result = await dispatchPendingEmails(repository, transport, {
      EMAIL_VERIFICATION: verification,
    });

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(transport.sent.map((m) => m.text)).toEqual([`entry ${first.id}`, `entry ${second.id}`]);
    expect(transport.sent.map((m) => m.to)).toEqual(["ana@example.com", "luis@example.com"]);
    expect(repository.entries.every((e) => e.sentAt !== null)).toBe(true);

    // Nothing is sent twice.
    expect(
      await dispatchPendingEmails(repository, transport, { EMAIL_VERIFICATION: verification }),
    ).toEqual({ sent: 0, failed: 0 });
    expect(transport.sent).toHaveLength(2);
  });

  it("leaves an entry pending when its kind has no composer, and still sends the others", async () => {
    const { repository, transport, advance } = setup();
    const orphan = repository.enqueue("PASSWORD_RESET", "user-1");
    advance(1_000);
    repository.enqueue("EMAIL_VERIFICATION", "user-2");

    const result = await dispatchPendingEmails(repository, transport, {
      EMAIL_VERIFICATION: verification,
    });

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(repository.entries.find((e) => e.id === orphan.id)?.sentAt).toBeNull();
    expect(transport.sent.map((m) => m.to)).toEqual(["luis@example.com"]);
  });

  it("leaves an entry pending when the transport fails, and tries it again on the next run", async () => {
    const { repository } = setup();
    const entry = repository.enqueue("EMAIL_VERIFICATION", "user-1");
    let fail = true;
    const sent: EmailMessage[] = [];
    const flaky = {
      send: async (message: EmailMessage) => {
        if (fail) throw new Error("smtp down");
        sent.push(message);
      },
    };

    expect(
      await dispatchPendingEmails(repository, flaky, { EMAIL_VERIFICATION: verification }),
    ).toEqual({ sent: 0, failed: 1 });
    expect(repository.entries.find((e) => e.id === entry.id)?.sentAt).toBeNull();

    fail = false;
    expect(
      await dispatchPendingEmails(repository, flaky, { EMAIL_VERIFICATION: verification }),
    ).toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("leaves an entry pending when its composer fails", async () => {
    const { repository, transport } = setup();
    repository.enqueue("EMAIL_VERIFICATION", "user-1");
    const broken: EmailComposer = async () => {
      throw new Error("cannot compose");
    };

    expect(
      await dispatchPendingEmails(repository, transport, { EMAIL_VERIFICATION: broken }),
    ).toEqual({ sent: 0, failed: 1 });
    expect(transport.sent).toEqual([]);
    expect(repository.entries[0]!.sentAt).toBeNull();
  });

  it("handles at most `limit` entries per run", async () => {
    const { repository, transport } = setup();
    for (let i = 0; i < 5; i++) repository.enqueue("EMAIL_VERIFICATION", "user-1");

    expect(
      await dispatchPendingEmails(
        repository,
        transport,
        { EMAIL_VERIFICATION: verification },
        {
          limit: 3,
        },
      ),
    ).toEqual({ sent: 3, failed: 0 });
    expect(repository.entries.filter((e) => e.sentAt === null)).toHaveLength(2);
  });
});

describe("assertDispatchAllowed", () => {
  it("allows only an explicit development or test NODE_ENV", () => {
    expect(() => assertDispatchAllowed("development")).not.toThrow();
    expect(() => assertDispatchAllowed("test")).not.toThrow();
    for (const value of ["production", undefined, "", "dev"]) {
      expect(() => assertDispatchAllowed(value)).toThrow();
    }
  });
});
