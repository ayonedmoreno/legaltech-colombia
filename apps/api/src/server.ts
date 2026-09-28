import { checkDatabaseConnection, createPrismaClient } from "@legaltech/database";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { loadStorageEnv } from "./config/storage-env.js";
import { PrismaAuthRepository } from "./modules/auth/auth.repository.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { PrismaCasesRepository } from "./modules/cases/cases.repository.js";
import { CasesService } from "./modules/cases/cases.service.js";
import { PrismaDocumentsRepository } from "./modules/documents/documents.repository.js";
import { DocumentsService } from "./modules/documents/documents.service.js";
import { S3StorageProvider } from "./storage/s3-storage.js";

const env = loadEnv();
const storageEnv = loadStorageEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const authService = new AuthService({
  repository: new PrismaAuthRepository(prisma),
  isProduction: env.NODE_ENV === "production",
});
const casesRepository = new PrismaCasesRepository(prisma);
const casesService = new CasesService({ repository: casesRepository });
const documentsService = new DocumentsService({
  repository: new PrismaDocumentsRepository(prisma),
  cases: casesRepository,
  storage: new S3StorageProvider(storageEnv),
  maxBytes: env.DOCUMENT_MAX_BYTES,
  downloadUrlTtlSeconds: env.DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
});
const app = await buildApp({
  env,
  health: { checkDatabase: () => checkDatabaseConnection(prisma) },
  authService,
  casesService,
  documentsService,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
