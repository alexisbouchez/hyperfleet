import { Elysia, t } from "elysia";
import type { MachineStatus } from "@hyperfleet/worker/database";
import type { MachineService } from "../services/machines";
import type { AuthService } from "../services/auth";
import type { Logger } from "@hyperfleet/logger";
import { getHttpStatus } from "@hyperfleet/errors";

const machineStatusEnum = t.Union([
  t.Literal("pending"),
  t.Literal("starting"),
  t.Literal("running"),
  t.Literal("paused"),
  t.Literal("stopping"),
  t.Literal("stopped"),
  t.Literal("failed"),
]);

const networkConfig = t.Object({
  tap_device: t.Optional(t.String()),
  tap_ip: t.Optional(t.String()),
  guest_ip: t.Optional(t.String()),
  guest_mac: t.Optional(t.String()),
});

const machineResponse = t.Object({
  id: t.String(),
  name: t.String(),
  status: machineStatusEnum,
  runtime_type: t.Literal("firecracker"),
  vcpu_count: t.Number(),
  mem_size_mib: t.Number(),
  kernel_image_path: t.String(),
  kernel_args: t.Nullable(t.String()),
  rootfs_path: t.Nullable(t.String()),
  network: t.Nullable(networkConfig),
  exposed_ports: t.Optional(t.Array(t.Number({ minimum: 1, maximum: 65535 }))),
  pid: t.Nullable(t.Number()),
  created_at: t.String(),
  updated_at: t.String(),
});

const errorResponse = t.Object({
  error: t.String(),
  message: t.String(),
});

const execResponse = t.Object({
  exit_code: t.Number(),
  stdout: t.String(),
  stderr: t.String(),
});

// Type for context with our derived services
type Context = {
  machineService: MachineService;
  authService: AuthService;
  logger: Logger;
};

/**
 * Validate API key from Authorization header
 */
async function validateAuth(
  request: Request,
  set: { status?: number | string },
  authService: AuthService,
  logger: Logger
): Promise<boolean> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    set.status = 401;
    return false;
  }

  const token = authHeader.slice(7);
  const apiKey = await authService.validateKey(token);

  if (!apiKey) {
    logger.warn("Invalid API key attempt", { prefix: token.slice(0, 11) });
    set.status = 401;
    return false;
  }

  logger.debug("Request authenticated", { keyId: apiKey.id, keyName: apiKey.name });
  return true;
}

export const machineRoutes = (disableAuth: boolean) =>
  new Elysia({ prefix: "/machines", tags: ["machines"] })
    // GET /machines - List all machines
    .get(
      "/",
      async (ctx) => {
        const { query, machineService, authService, logger, request, set } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        return machineService.list(query.status as MachineStatus | undefined);
      },
      {
        query: t.Object({
          status: t.Optional(machineStatusEnum),
        }),
        response: t.Union([t.Array(machineResponse), errorResponse]),
        detail: {
          summary: "List machines",
          description: "List all Firecracker machines, optionally filtered by status",
        },
      }
    )

    // POST /machines - Create a new machine
    .post(
      "/",
      async (ctx) => {
        const { body, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await machineService.create(body);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }
        set.status = 201;
        return result.unwrap();
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1, description: "Machine name" }),
          vcpu_count: t.Number({ minimum: 1, description: "Number of vCPUs" }),
          mem_size_mib: t.Number({ minimum: 4, description: "Memory in MiB" }),
          kernel_image_path: t.String({ description: "Path to kernel image" }),
          kernel_args: t.Optional(t.String({ description: "Kernel boot arguments" })),
          rootfs_path: t.Optional(t.String({ description: "Path to root filesystem image" })),
          network: t.Optional(t.Object({
            tap_device: t.Optional(t.String({ description: "TAP device name" })),
            tap_ip: t.Optional(t.String({ description: "TAP device IP address" })),
            guest_ip: t.Optional(t.String({ description: "Guest VM IP address" })),
            guest_mac: t.Optional(t.String({ description: "Guest VM MAC address" })),
          }, { description: "Network configuration for internet access" })),
          exposed_ports: t.Optional(t.Array(
            t.Number({ minimum: 1, maximum: 65535 }),
            { description: "Ports to expose via reverse proxy" }
          )),
        }),
        response: {
          201: machineResponse,
          400: errorResponse,
          401: errorResponse,
        },
        detail: {
          summary: "Create machine",
          description: "Create a new Firecracker microVM with the specified configuration.",
        },
      }
    )

    // GET /machines/:id - Get machine by ID
    .get(
      "/:id",
      async (ctx) => {
        const { params, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const machine = await machineService.get(params.id);
        if (!machine) {
          set.status = 404;
          return { error: "not_found", message: "Machine not found" };
        }
        return machine;
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        response: {
          200: machineResponse,
          401: errorResponse,
          404: errorResponse,
        },
        detail: {
          summary: "Get machine",
          description: "Get details of a specific machine by ID",
        },
      }
    )

    // DELETE /machines/:id - Delete a machine
    .delete(
      "/:id",
      async (ctx) => {
        const { params, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const machine = await machineService.get(params.id);
        if (!machine) {
          set.status = 404;
          return { error: "not_found", message: "Machine not found" };
        }

        if (machine.status === "running" || machine.status === "starting") {
          await machineService.stop(params.id);
        }

        await machineService.delete(params.id);
        set.status = 204;
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        response: {
          204: t.Void(),
          401: errorResponse,
          404: errorResponse,
        },
        detail: {
          summary: "Delete machine",
          description: "Delete a machine. If running, it will be stopped first.",
        },
      }
    )

    // POST /machines/:id/start - Start a machine
    .post(
      "/:id/start",
      async (ctx) => {
        const { params, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await machineService.start(params.id);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }
        return result.unwrap();
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        response: {
          200: machineResponse,
          401: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
        detail: {
          summary: "Start machine",
          description: "Start a stopped or pending machine",
        },
      }
    )

    // POST /machines/:id/stop - Stop a machine
    .post(
      "/:id/stop",
      async (ctx) => {
        const { params, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await machineService.stop(params.id);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }
        return result.unwrap();
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        response: {
          200: machineResponse,
          401: errorResponse,
          404: errorResponse,
        },
        detail: {
          summary: "Stop machine",
          description: "Stop a running machine gracefully",
        },
      }
    )

    // POST /machines/:id/restart - Restart a machine
    .post(
      "/:id/restart",
      async (ctx) => {
        const { params, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await machineService.restart(params.id);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }
        return result.unwrap();
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        response: {
          200: machineResponse,
          401: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
        detail: {
          summary: "Restart machine",
          description: "Restart a machine (stop then start)",
        },
      }
    )

    // POST /machines/:id/exec - Execute command on a machine
    .post(
      "/:id/exec",
      async (ctx) => {
        const { params, body, set, machineService, authService, logger, request } = ctx as typeof ctx & Context;

        if (!disableAuth && !(await validateAuth(request, set, authService, logger))) {
          return { error: "unauthorized", message: "Invalid or missing API key" };
        }

        const result = await machineService.exec(params.id, body);
        if (result.isErr()) {
          set.status = getHttpStatus(result.error);
          return { error: result.error._tag, message: result.error.message };
        }
        return result.unwrap();
      },
      {
        params: t.Object({
          id: t.String({ description: "Machine ID" }),
        }),
        body: t.Object({
          cmd: t.Array(t.String(), { description: "Command and arguments to execute" }),
          timeout: t.Optional(t.Number({ minimum: 1, description: "Timeout in seconds" })),
        }),
        response: {
          200: execResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
        detail: {
          summary: "Execute command",
          description: "Execute a command on a running machine and return stdout, stderr, and exit code",
        },
      }
    );
