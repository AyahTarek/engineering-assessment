import { statusEventSchema } from "@assessment/contracts";
import { prisma, type PrismaClient } from "@assessment/database";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  ApplicationNotFoundError,
  getApplicationForCustomer,
  listApplicationsForCustomer,
  recordStatusEvent,
  type RecordOutcome,
} from "./application-service.js";

interface BuildAppOptions {
  database?: PrismaClient;
  logger?: boolean;
}

// Keyed on RecordOutcome (not inferred from this object's own keys), so
// adding/renaming an outcome there fails to compile here instead of silently
// falling through with no HTTP status. A stale or invalid-transition event
// was never applied, so it is 409 (not 200) to avoid implying it took effect.
const STATUS_BY_OUTCOME: Readonly<Record<RecordOutcome, number>> = {
  accepted: 202,
  duplicate: 200,
  stale: 409,
  terminal: 409,
  invalid: 409,
};

export function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? prisma;
  const app = Fastify({ logger: options.logger ?? true });

  void app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/applications", async (request, reply) => {
    const customerId = request.headers["x-customer-id"];
    if (typeof customerId !== "string" || customerId.length === 0) {
      return reply.code(401).send({ error: "customer identity is required" });
    }

    const applications = await listApplicationsForCustomer(
      database,
      customerId,
    );
    return { applications };
  });

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
        return reply
          .code(STATUS_BY_OUTCOME[outcome])
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
