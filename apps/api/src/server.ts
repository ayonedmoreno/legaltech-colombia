import { checkDatabaseConnection, createPrismaClient } from "@legaltech/database";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { PrismaAuthRepository } from "./modules/auth/auth.repository.js";
import { AuthService } from "./modules/auth/auth.service.js";

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const authService = new AuthService({
  repository: new PrismaAuthRepository(prisma),
  isProduction: env.NODE_ENV === "production",
});
const app = await buildApp({
  env,
  health: { checkDatabase: () => checkDatabaseConnection(prisma) },
  authService,
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
