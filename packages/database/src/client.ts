import { PrismaClient } from "@prisma/client";

/** Creates a Prisma client. When no URL is given, DATABASE_URL from the environment is used. */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
    log: ["warn", "error"],
  });
}

/** Returns true when the database answers a trivial query. Never throws. */
export async function checkDatabaseConnection(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
