import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import type { Kysely, Database } from "@hyperfleet/worker/database";
import { createLogger, generateCorrelationId, type Logger } from "@hyperfleet/logger";
import { MachineService } from "./services/machines";
import { FileService } from "./services/files";
import { AuthService } from "./services/auth";
import { machineRoutes, fileRoutes } from "./routes";

// Export AuthService for creating API keys
export { AuthService } from "./services/auth";

export interface AppConfig {
  db: Kysely<Database>;
  /** Set to true to disable API key authentication (for development) */
  disableAuth?: boolean;
}

export function createApp(config: AppConfig) {
  const authService = new AuthService(config.db);

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
            {
              name: "files",
              description: "File transfer operations",
            },
          ],
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                description: "API key authentication. Use: Authorization: Bearer hf_xxx",
              },
            },
          },
          security: [{ bearerAuth: [] }],
        },
        path: "/docs",
        exclude: ["/docs", "/docs/json"],
      })
    )

    // Add correlation ID and logger to request context
    .derive(({ request }) => {
      const correlationId =
        request.headers.get("x-correlation-id") || generateCorrelationId();
      const logger = createLogger({
        correlationId,
        path: new URL(request.url).pathname,
        method: request.method,
      });
      const machineService = new MachineService(config.db, logger);
      const fileService = new FileService(config.db, logger);
      return { correlationId, logger, machineService, fileService, authService };
    })

    // Health check (public)
    .get("/health", () => ({ status: "ok" }))

    // Machine routes
    .use(machineRoutes(config.disableAuth ?? false))

    // File routes
    .use(fileRoutes(config.disableAuth ?? false))

    // Global error handler
    .onError(({ code, error, set, logger }) => {
      const log = logger as Logger | undefined;
      const err = error as Error;

      // Check if status was already set (e.g., by auth middleware)
      const status = set.status as number;

      if (status === 401) {
        log?.warn(`Unauthorized request: ${err.message}`, { code });
        return {
          error: "unauthorized",
          message: err.message,
        };
      }

      log?.error(`Request failed: ${err.message}`, {
        code,
        stack: err.stack,
      });

      if (code === "VALIDATION") {
        set.status = 400;
        return {
          error: "validation_error",
          message: err.message,
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
