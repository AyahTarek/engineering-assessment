import { statusEventSchema } from "@assessment/contracts";
import { prisma, type PrismaClient } from "@assessment/database";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  ApplicationNotFoundError,
  getApplicationForCustomer,
  recordStatusEvent,
} from "./application-service.js";

interface BuildAppOptions {
  database?: PrismaClient;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? prisma;
  const app = Fastify({ logger: options.logger ?? true });

  void app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Params: { applicationId: string } }>(
    "/v1/applications/:applicationId",
    async (request, reply) => {
      const customerId = request.headers["x-customer-id"];
      if (typeof customerId !== "string" || customerId.length === 0) {
        return reply.code(401).send({ error: "customer identity is required" });
      }

      const application = await getApplicationForCustomer(
        database,
        request.params.applicationId,
        customerId,
      );

      if (!application) {
        return reply.code(404).send({ error: "application not found" });
      }

      return application;
    },
  );

  app.post<{ Params: { applicationId: string } }>(
    "/v1/applications/:applicationId/status-events",
    async (request, reply) => {
      const parsed = statusEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid status event",
          details: parsed.error.flatten(),
        });
      }

      request.log.info(
        { applicationId: request.params.applicationId, event: parsed.data },
        "received partner status event",
      );

      try {
        const { outcome, application } = await recordStatusEvent(
          database,
          request.params.applicationId,
          parsed.data,
        );
        // Distinct signals per DOMAIN.md. A stale event was never applied, so
        // it is a 409 (not a 200) to avoid implying it took effect.
        const statusByOutcome = {
          accepted: 202,
          duplicate: 200,
          stale: 409,
          terminal: 409,
        } as const;
        return reply
          .code(statusByOutcome[outcome])
          .send({ outcome, application });
      } catch (error) {
        if (error instanceof ApplicationNotFoundError) {
          return reply.code(404).send({ error: "application not found" });
        }
        throw error;
      }
    },
  );

  return app;
}
