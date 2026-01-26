import { Result } from "better-result";
import type { Kysely } from "@hyperfleet/worker/database";
import type { Database, Machine } from "@hyperfleet/worker/database";
import {
  NotFoundError,
  ValidationError,
  RuntimeError,
  getHttpStatus,
  type HyperfleetError,
} from "@hyperfleet/errors";
import { createLogger, generateCorrelationId } from "@hyperfleet/logger";

const DEFAULT_PROXY_PORT = 4000;
const DEFAULT_PROXY_PREFIX = "/proxy";
const DEFAULT_HOST_PORT = 80;
const DEFAULT_EXPOSED_PORT_POLL_INTERVAL_MS = 10_000;

type ProxyTarget = {
  host: string;
  port: number;
};

type ProxyMachineConfig = Pick<Machine, "id" | "runtime_type" | "status" | "config_json">;

type VmProxyConfig = {
  exposedPorts?: number[];
};

type FetchFn = (request: Request) => Promise<Response>;

export interface ReverseProxyConfig {
  db: Kysely<Database>;
  port?: number;
  prefix?: string;
  hostSuffix?: string;
  exposedPortPollIntervalMs?: number;
}

export interface ReverseProxyHandlerConfig {
  db: Kysely<Database>;
  prefix?: string;
  fetchFn?: FetchFn;
  hostSuffix?: string;
  defaultPort?: number;
}

export function parseProxyPort(value: string | undefined): Result<number, ValidationError> {
  if (!value) {
    return Result.ok(DEFAULT_PROXY_PORT);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return Result.err(new ValidationError({ message: "PROXY_PORT must be a valid TCP port" }));
  }

  return Result.ok(parsed);
}

function parseProxyPath(
  pathname: string,
  prefix: string
): Result<{ machineId: string; forwardPath: string }, ValidationError> {
  if (!pathname.startsWith(`${prefix}/`)) {
    return Result.err(new ValidationError({ message: "Invalid proxy path" }));
  }

  const withoutPrefix = pathname.slice(prefix.length);
  const segments = withoutPrefix.split("/").filter(Boolean);
  const machineId = segments[0];

  if (!machineId) {
    return Result.err(new ValidationError({ message: "Machine id is required in proxy path" }));
  }

  const forwardSegments = segments.slice(1);
  const forwardPath = `/${forwardSegments.join("/")}`;
  return Result.ok({ machineId, forwardPath: forwardSegments.length ? forwardPath : "/" });
}

function parsePortParam(
  searchParams: URLSearchParams
): Result<number | null, ValidationError> {
  const portParam = searchParams.get("port");
  if (!portParam) {
    return Result.ok(null);
  }

  const parsed = Number(portParam);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return Result.err(new ValidationError({ message: "port must be a valid TCP port" }));
  }

  return Result.ok(parsed);
}

function parseHostPort(
  url: URL,
  defaultPort: number
): Result<number, ValidationError> {
  const portValue = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return Result.err(new ValidationError({ message: "port must be a valid TCP port" }));
  }
  return Result.ok(portValue);
}

function normalizeHostSuffix(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^\.+/, "");
  return trimmed ? trimmed.toLowerCase() : null;
}

function parseProxyHost(
  hostname: string,
  hostSuffix: string
): Result<string, ValidationError> {
  const normalized = hostname.toLowerCase();
  const suffix = `.${hostSuffix}`;
  if (!normalized.endsWith(suffix)) {
    return Result.err(new ValidationError({ message: "Invalid proxy host" }));
  }

  const machineId = normalized.slice(0, -suffix.length);
  if (!machineId) {
    return Result.err(new ValidationError({ message: "Machine id is required in proxy host" }));
  }

  return Result.ok(machineId);
}

function normalizeExposedPorts(
  ports: number[]
): Result<number[], ValidationError> {
  const unique = Array.from(new Set(ports));
  for (const port of unique) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Result.err(
        new ValidationError({ message: "exposed_ports must be valid TCP ports" })
      );
    }
  }
  return Result.ok(unique);
}

function getVmExposedPorts(
  machine: ProxyMachineConfig
): Result<number[] | null, HyperfleetError> {
  const configResult = Result.try(() => JSON.parse(machine.config_json) as VmProxyConfig);
  if (configResult.isErr()) {
    return Result.err(
      new RuntimeError({
        message: "Failed to parse machine config for proxying",
        cause: configResult.error,
      })
    );
  }

  const exposedPorts = configResult.unwrap().exposedPorts;
  if (!exposedPorts || exposedPorts.length === 0) {
    return Result.ok(null);
  }

  const normalizedResult = normalizeExposedPorts(exposedPorts);
  if (normalizedResult.isErr()) {
    return Result.err(normalizedResult.error);
  }

  return Result.ok(normalizedResult.unwrap());
}

function resolveVmPort(
  requestedPort: number | null,
  exposedPorts: number[] | null
): Result<number | null, ValidationError> {
  if (!exposedPorts || exposedPorts.length === 0) {
    return Result.ok(requestedPort);
  }

  if (requestedPort === null) {
    if (exposedPorts.length === 1) {
      return Result.ok(exposedPorts[0]);
    }
    return Result.err(
      new ValidationError({ message: "port must be specified when multiple ports are exposed" })
    );
  }

  if (!exposedPorts.includes(requestedPort)) {
    return Result.err(
      new ValidationError({ message: `Port ${requestedPort} is not exposed for this machine` })
    );
  }

  return Result.ok(requestedPort);
}

function resolveProxyTarget(
  machine: Machine,
  requestedPort: number | null
): Result<ProxyTarget, HyperfleetError> {
  if (machine.status !== "running") {
    return Result.err(new ValidationError({ message: "Machine must be running to proxy traffic" }));
  }

  if (!machine.guest_ip) {
    return Result.err(
      new ValidationError({ message: "Machine has no guest IP configured for proxying" })
    );
  }

  return Result.ok({ host: machine.guest_ip, port: requestedPort ?? 80 });
}

function buildUpstreamRequest(request: Request, url: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const init: globalThis.RequestInit = {
    method: request.method,
    headers,
    redirect: "manual" as const,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return new Request(url, init);
}

function errorResponse(error: HyperfleetError): Response {
  return new Response(
    JSON.stringify({ error: error._tag, message: error.message }),
    {
      status: getHttpStatus(error),
      headers: { "content-type": "application/json" },
    }
  );
}

export function startReverseProxy(config: ReverseProxyConfig): ReturnType<typeof Bun.serve> {
  const prefix = config.prefix ?? DEFAULT_PROXY_PREFIX;
  const port = config.port ?? DEFAULT_PROXY_PORT;
  const hostSuffix = normalizeHostSuffix(config.hostSuffix);

  const controlServer = Bun.serve({
    port,
    fetch: createReverseProxyHandler({
      db: config.db,
      prefix,
      hostSuffix: hostSuffix ?? undefined,
      defaultPort: port,
    }),
  });

  if (hostSuffix) {
    const pollInterval =
      config.exposedPortPollIntervalMs ?? DEFAULT_EXPOSED_PORT_POLL_INTERVAL_MS;
    const portServers = new Map<number, ReturnType<typeof Bun.serve>>();
    let syncing = false;

    const syncPorts = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const machines = await config.db
          .selectFrom("machines")
          .select(["id", "runtime_type", "status", "config_json"])
          .where("status", "=", "running")
          .where("runtime_type", "=", "firecracker")
          .execute();

        const desiredPorts = new Set<number>();
        for (const machine of machines) {
          const exposedResult = getVmExposedPorts(machine);
          if (exposedResult.isErr()) {
            console.warn("Failed to resolve exposed ports", {
              machineId: machine.id,
              error: exposedResult.error.message,
            });
            continue;
          }
          for (const port of exposedResult.unwrap() ?? []) {
            if (port !== controlServer.port) {
              desiredPorts.add(port);
            }
          }
        }

        for (const port of desiredPorts) {
          if (portServers.has(port)) continue;
          try {
            const server = Bun.serve({
              port,
              fetch: createReverseProxyHandler({
                db: config.db,
                prefix,
                hostSuffix,
                defaultPort: port,
              }),
            });
            portServers.set(port, server);
          } catch (error) {
            console.error(`Failed to start proxy port ${port}:`, error);
          }
        }

        for (const [port, server] of portServers.entries()) {
          if (!desiredPorts.has(port)) {
            server.stop();
            portServers.delete(port);
          }
        }
      } finally {
        syncing = false;
      }
    };

    void syncPorts();
    if (pollInterval > 0) {
      setInterval(() => void syncPorts(), pollInterval);
    }
  }

  return controlServer;
}

export function createReverseProxyHandler(
  config: ReverseProxyHandlerConfig
): (request: Request) => Promise<Response> {
  const prefix = config.prefix ?? DEFAULT_PROXY_PREFIX;
  const fetchFn: FetchFn = config.fetchFn ?? ((request) => fetch(request));
  const hostSuffix = normalizeHostSuffix(config.hostSuffix);
  const defaultPort = config.defaultPort ?? DEFAULT_HOST_PORT;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const isPathProxy = url.pathname.startsWith(`${prefix}/`);
    const isHostProxy = Boolean(hostSuffix);
    const correlationId =
      request.headers.get("x-correlation-id") ?? generateCorrelationId();

    const logger = createLogger({
      correlationId,
      path: url.pathname,
      method: request.method,
      component: "reverse-proxy",
      host: url.hostname,
    });

    let machineId: string | null = null;
    let forwardPath = url.pathname;
    let requestedPort: number | null = null;
    let routeMode: "path" | "host" | null = null;

    if (isPathProxy) {
      const pathResult = parseProxyPath(url.pathname, prefix);
      if (pathResult.isErr()) {
        logger.warn("Invalid proxy path", { error: pathResult.error.message });
        return errorResponse(pathResult.error);
      }

      const portResult = parsePortParam(url.searchParams);
      if (portResult.isErr()) {
        logger.warn("Invalid proxy port parameter", { error: portResult.error.message });
        return errorResponse(portResult.error);
      }

      const pathData = pathResult.unwrap();
      machineId = pathData.machineId;
      forwardPath = pathData.forwardPath;
      requestedPort = portResult.unwrap();
      routeMode = "path";
    } else if (isHostProxy && hostSuffix) {
      const hostResult = parseProxyHost(url.hostname, hostSuffix);
      if (hostResult.isErr()) {
        return new Response("Not Found", { status: 404 });
      }

      const portResult = parseHostPort(url, defaultPort);
      if (portResult.isErr()) {
        logger.warn("Invalid proxy host port", { error: portResult.error.message });
        return errorResponse(portResult.error);
      }

      machineId = hostResult.unwrap();
      requestedPort = portResult.unwrap();
      routeMode = "host";
    } else {
      return new Response("Not Found", { status: 404 });
    }

    if (!machineId || !routeMode) {
      return new Response("Not Found", { status: 404 });
    }

    const machine = await config.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", machineId)
      .executeTakeFirst();

    if (!machine) {
      return errorResponse(new NotFoundError({ message: "Machine not found" }));
    }

    const exposedPortsResult = getVmExposedPorts(machine);
    if (exposedPortsResult.isErr()) {
      logger.warn("Failed to resolve exposed ports", {
        error: exposedPortsResult.error.message,
      });
      return errorResponse(exposedPortsResult.error);
    }

    const resolvedPortResult = resolveVmPort(requestedPort, exposedPortsResult.unwrap());
    if (resolvedPortResult.isErr()) {
      logger.warn("Requested port not exposed", { error: resolvedPortResult.error.message });
      return errorResponse(resolvedPortResult.error);
    }
    requestedPort = resolvedPortResult.unwrap();

    const targetResult = resolveProxyTarget(machine, requestedPort);
    if (targetResult.isErr()) {
      logger.warn("Failed to resolve proxy target", { error: targetResult.error.message });
      return errorResponse(targetResult.error);
    }

    const forwardedParams = new URLSearchParams(url.searchParams);
    if (routeMode === "path") {
      forwardedParams.delete("port");
    }
    const target = targetResult.unwrap();
    const targetUrl = new URL(`http://${target.host}:${target.port}${forwardPath}`);
    if (forwardedParams.size > 0) {
      targetUrl.search = forwardedParams.toString();
    }

    const upstreamRequest = buildUpstreamRequest(request, targetUrl.toString());
    const upstreamResult = await Result.tryPromise({
      try: () => fetchFn(upstreamRequest),
      catch: (error) =>
        new RuntimeError({
          message: "Failed to reach upstream service",
          cause: error,
        }),
    });

    if (upstreamResult.isErr()) {
      logger.error("Upstream request failed", { error: upstreamResult.error.message });
      return errorResponse(upstreamResult.error);
    }

    const upstreamResponse = upstreamResult.unwrap();
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  };
}
