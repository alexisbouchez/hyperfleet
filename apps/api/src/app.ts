import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import type { Kysely, Database } from "@hyperfleet/worker/database";
import { MachineService } from "./services/machines";
import { machineRoutes } from "./routes";

export interface AppConfig {
  db: Kysely<Database>;
}

export function createApp(config: AppConfig) {
  const machineService = new MachineService(config.db);

  const app = new Elysia()
    // Swagger/OpenAPI documentation
    .use(
      swagger({
        documentation: {
          info: {
            title: "Hyperfleet API",
            version: "0.0.1",
            description: "REST API for managing Firecracker microVMs",
          },
          tags: [
            {
              name: "machines",
              description: "Machine lifecycle operations",
            },
          ],
        },
        path: "/docs",
        exclude: ["/docs", "/docs/json"],
      })
    )

    // Health check
    .get("/health", () => ({ status: "ok" }))

    // Machine routes
    .use(machineRoutes(machineService))

    // Global error handler
    .onError(({ code, error, set }) => {
      console.error(`[${code}]`, error);

      if (code === "VALIDATION") {
        set.status = 400;
        return {
          error: "validation_error",
          message: error.message,
        };
      }

      set.status = 500;
      return {
        error: "internal_error",
        message: "An unexpected error occurred",
      };
    });

  return app;
}
