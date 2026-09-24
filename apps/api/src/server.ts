import { checkDatabaseConnection, createPrismaClient } from "@legaltech/database";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const app = await buildApp({
  env,
  health: { checkDatabase: () => checkDatabaseConnection(prisma) },
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
