import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { FakeAuthRepository } from "../modules/auth/auth.repository.fake.js";
import { AuthService } from "../modules/auth/auth.service.js";
import type { Clock } from "../modules/auth/auth.session.js";
import { FakeCasesRepository } from "../modules/cases/cases.repository.fake.js";
import { CasesService } from "../modules/cases/cases.service.js";
import { FakeDocumentsRepository } from "../modules/documents/documents.repository.fake.js";
import { DocumentsService } from "../modules/documents/documents.service.js";
import { MemoryStorageProvider } from "@legaltech/storage";

export const TEST_ENV = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://unused",
});

export interface TestApp {
  app: FastifyInstance;
  repository: FakeAuthRepository;
  casesRepository: FakeCasesRepository;
  documentsRepository: FakeDocumentsRepository;
  storage: MemoryStorageProvider;
}

export interface BuildTestAppOptions {
  databaseUp?: boolean;
  isProduction?: boolean;
  clock?: Clock;
  accountLoginAttemptLimit?: number;
  accountLoginWindowMs?: number;
  /** A preconfigured (e.g. subclassed) fake repository; a fresh one is created if omitted. */
  repository?: FakeAuthRepository;
  /** A preconfigured fake cases repository; a fresh one is created if omitted. */
  casesRepository?: FakeCasesRepository;
  /** A preconfigured fake documents repository (built over the cases one if omitted). */
  documentsRepository?: FakeDocumentsRepository;
  storage?: MemoryStorageProvider;
  /** A smaller upload limit in bytes (DOCUMENT_MAX_BYTES, 10 MiB, otherwise). */
  documentMaxBytes?: number;
  /** Trusted proxy addresses (API_TRUST_PROXY); none by default, as in the real default. */
  trustProxy?: string[];
}

/** Builds a full app wired to an in-memory FakeAuthRepository — no PostgreSQL required. */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const repository = options.repository ?? new FakeAuthRepository();
  const casesRepository = options.casesRepository ?? new FakeCasesRepository();
  if (options.clock) {
    repository.clock = options.clock;
    casesRepository.clock = options.clock;
  }
  const documentsRepository =
    options.documentsRepository ?? new FakeDocumentsRepository(casesRepository);
  if (options.clock) documentsRepository.clock = options.clock;
  const storage = options.storage ?? new MemoryStorageProvider();

  const authService = new AuthService({
    repository,
    isProduction: options.isProduction ?? false,
    clock: options.clock,
    accountLoginAttemptLimit: options.accountLoginAttemptLimit,
    accountLoginWindowMs: options.accountLoginWindowMs,
  });

  const app = await buildApp({
    env: { ...TEST_ENV, API_TRUST_PROXY: options.trustProxy ?? TEST_ENV.API_TRUST_PROXY },
    health: { checkDatabase: async () => options.databaseUp ?? true },
    authService,
    casesService: new CasesService({ repository: casesRepository }),
    documentsService: new DocumentsService({
      repository: documentsRepository,
      cases: casesRepository,
      storage,
      maxBytes: options.documentMaxBytes,
      downloadUrlTtlSeconds: TEST_ENV.DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
      clock: options.clock,
    }),
  });

  return { app, repository, casesRepository, documentsRepository, storage };
}
