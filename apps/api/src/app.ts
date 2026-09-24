import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "./config/env.js";
import { healthRoutes, type HealthDeps } from "./modules/health/health.routes.js";
import { registerErrorHandler } from "./plugins/error-handler.js";

export interface AppOptions {
  env: Env;
  health: HealthDeps;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp({ env, health }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[REDACTED]",
      },
    },
    // Accept a well-formed inbound request id; otherwise generate one.
    genReqId: (request) => {
      const inbound = request.headers["x-request-id"];
      return typeof inbound === "string" && REQUEST_ID_PATTERN.test(inbound)
        ? inbound
        : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(helmet);
  registerErrorHandler(app);
  await app.register(healthRoutes, { prefix: "/api/health", checkDatabase: health.checkDatabase });

  return app;
}
