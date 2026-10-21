import Fastify from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Logger } from "pino";
import { toHttpError } from "./errors.js";
import type { ShadowStats } from "./repos/shadow.js";
import { type BookingRoutesDeps, bookingRoutes } from "./routes/bookings.js";

export type AppDeps = BookingRoutesDeps & { logger: Logger; shadowStats: ShadowStats };

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ loggerInstance: deps.logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      // Paths and messages only: the rejected values are not echoed back.
      const issues = error.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message,
      }));
      return reply
        .code(400)
        .send({ code: "INVALID_REQUEST", message: "The request is not valid.", issues });
    }
    const mapped = toHttpError(error);
    if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ code: "INTERNAL", message: "Something went wrong." });
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/debug/shadow-stats", async () => deps.shadowStats);
  await app.register(async (scope) => bookingRoutes(scope, deps));
  return app;
}
