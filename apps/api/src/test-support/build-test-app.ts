import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { FakeAuthRepository } from "../modules/auth/auth.repository.fake.js";
import { AuthService } from "../modules/auth/auth.service.js";
import type { Clock } from "../modules/auth/auth.session.js";

export const TEST_ENV = loadEnv({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgresql://unused",
});

export interface TestApp {
  app: FastifyInstance;
  repository: FakeAuthRepository;
}

export interface BuildTestAppOptions {
  databaseUp?: boolean;
  isProduction?: boolean;
  clock?: Clock;
  accountLoginAttemptLimit?: number;
  accountLoginWindowMs?: number;
  /** A preconfigured (e.g. subclassed) fake repository; a fresh one is created if omitted. */
  repository?: FakeAuthRepository;
}

/** Builds a full app wired to an in-memory FakeAuthRepository — no PostgreSQL required. */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const repository = options.repository ?? new FakeAuthRepository();
  if (options.clock) repository.clock = options.clock;

  const authService = new AuthService({
    repository,
    isProduction: options.isProduction ?? false,
    clock: options.clock,
    accountLoginAttemptLimit: options.accountLoginAttemptLimit,
    accountLoginWindowMs: options.accountLoginWindowMs,
  });

  const app = await buildApp({
    env: TEST_ENV,
    health: { checkDatabase: async () => options.databaseUp ?? true },
    authService,
  });

  return { app, repository };
}
