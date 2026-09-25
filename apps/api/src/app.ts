import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "./config/env.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import type { AuthService } from "./modules/auth/auth.service.js";
import { healthRoutes, type HealthDeps } from "./modules/health/health.routes.js";
import { registerErrorHandler } from "./plugins/error-handler.js";

export interface AppOptions {
  env: Env;
  health: HealthDeps;
  authService: AuthService;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function buildApp({ env, health, authService }: AppOptions): Promise<FastifyInstance> {
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
  // No secret is used to sign cookies: session and CSRF tokens are themselves high-entropy
  // opaque secrets, validated against their stored hash (ADR-002); cookie signing would add
  // a second secret to manage without a corresponding security gain.
  await app.register(cookie);
  registerErrorHandler(app);
  // Before any route can serve a request: see AuthService.warmUp.
  await authService.warmUp();
  await app.register(healthRoutes, { prefix: "/api/health", checkDatabase: health.checkDatabase });
  await app.register(authRoutes, { prefix: "/api/auth", authService, appOrigin: env.APP_ORIGIN });

  return app;
}
