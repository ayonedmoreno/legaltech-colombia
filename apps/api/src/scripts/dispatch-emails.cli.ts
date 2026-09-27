import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@legaltech/database";
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from "../modules/auth/auth.email-settings.js";
import { createEmailComposers } from "../modules/notifications/composers.js";
import { assertDispatchAllowed, dispatchPendingEmails } from "../modules/notifications/dispatch.js";
import { PrismaOutboxRepository } from "../modules/notifications/outbox.repository.js";
import { FileEmailTransport } from "../modules/notifications/transports.js";

/**
 * `pnpm email:dispatch`: sends the pending outbox emails once, to files in `.dev-mail/` at the
 * repository root (git-ignored). Development only (Sprint 1B decision P2/P3); in production,
 * dispatch belongs to the Phase 3 worker. Only counts are printed: a message may carry a token.
 */
assertDispatchAllowed(process.env.NODE_ENV);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set.");
const appOrigin = process.env.APP_ORIGIN;
if (!appOrigin) throw new Error("APP_ORIGIN must be set: email links point to it.");

const directory = fileURLToPath(new URL("../../../../.dev-mail/", import.meta.url));
const prisma = createPrismaClient(databaseUrl);

try {
  const { sent, failed } = await dispatchPendingEmails(
    new PrismaOutboxRepository(prisma),
    new FileEmailTransport(directory),
    createEmailComposers({
      appOrigin,
      emailVerificationTokenTtlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
      passwordResetTokenTtlMs: PASSWORD_RESET_TOKEN_TTL_MS,
    }),
  );
  console.log(`emails sent: ${sent}, left pending after a failure: ${failed}`);
} finally {
  await prisma.$disconnect();
}
