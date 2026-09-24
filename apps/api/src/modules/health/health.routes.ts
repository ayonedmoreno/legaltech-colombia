import type { HealthResponse } from "@legaltech/contracts";
import type { FastifyPluginAsync } from "fastify";

export interface HealthDeps {
  checkDatabase: () => Promise<boolean>;
}

/** Infrastructure endpoints: no authentication and no sensitive information (API_SPEC.md). */
export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (app, opts) => {
  app.get("/live", async () => {
    const body: HealthResponse = { status: "ok" };
    return body;
  });

  app.get("/ready", async (_request, reply) => {
    const databaseUp = await opts.checkDatabase();
    const body: HealthResponse = { status: databaseUp ? "ok" : "unavailable" };
    return reply.code(databaseUp ? 200 : 503).send(body);
  });
};
