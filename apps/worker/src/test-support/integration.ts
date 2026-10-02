import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";

/**
 * Real services for the worker's integration tests (opt-in, like the API's). Never point them
 * at a development database: audit_logs rows cannot be deleted.
 */
export const integration = {
  appDatabaseUrl: process.env.INTEGRATION_DATABASE_URL,
  workerDatabaseUrl: process.env.INTEGRATION_WORKER_DATABASE_URL,
  /** Test-only: reads what no runtime role may read, and runs the owner's OCR activation. */
  ownerDatabaseUrl: process.env.INTEGRATION_OWNER_DATABASE_URL,
  s3Endpoint: process.env.INTEGRATION_S3_ENDPOINT,
  s3AccessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "",
  s3SecretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "",
  clamavHost: process.env.INTEGRATION_CLAMAV_HOST ?? "127.0.0.1",
  clamavPort: Number(process.env.INTEGRATION_CLAMAV_PORT ?? 0),
};

export const hasDatabase = Boolean(integration.appDatabaseUrl && integration.workerDatabaseUrl);
export const hasOwner = Boolean(hasDatabase && integration.ownerDatabaseUrl);
export const hasPipeline = Boolean(hasDatabase && integration.s3Endpoint && integration.clamavPort);

/** The EICAR antivirus test file, assembled at run time so no file in the repository holds it. */
export function eicar(): Buffer {
  return Buffer.from(
    ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-", "TEST-FILE!$H+H*"].join(""),
    "latin1",
  );
}

/**
 * A user, a DRAFT case and a document row, written as the application role (as the API does).
 * The document starts in `status` (PENDING_SCAN unless told otherwise).
 */
export async function seedDocument(
  app: PrismaClient,
  document: {
    fileType: "PDF" | "JPEG" | "PNG";
    fileSize: number;
    status?: "UPLOADED" | "PENDING_SCAN";
  },
) {
  const user = await app.user.create({
    data: {
      email: `it-${randomUUID()}@example.com`,
      passwordHash: "$argon2id$integration-test-placeholder",
      fullName: "Integración",
    },
  });
  const caseRow = await app.case.create({
    data: {
      userId: user.id,
      type: "OTHER",
      status: "DRAFT",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const id = randomUUID();
  const created = await app.document.create({
    data: {
      id,
      caseId: caseRow.id,
      fileName: "comparendo.pdf",
      fileType: document.fileType,
      storageKey: `cases/${caseRow.id}/documents/${id}`,
      fileSize: document.fileSize,
      uploadedByUserId: user.id,
      createdAt: new Date(),
      status: document.status ?? "PENDING_SCAN",
    },
  });
  return created;
}

/** The owner's client: test assertions and the OCR activation only, never the runtime path. */
export function ownerClient(): PrismaClient {
  return createPrismaClient(integration.ownerDatabaseUrl!);
}

export function clients() {
  return {
    app: createPrismaClient(integration.appDatabaseUrl!),
    worker: createPrismaClient(integration.workerDatabaseUrl!),
  };
}
