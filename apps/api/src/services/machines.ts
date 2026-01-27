import net from "node:net";
import { customAlphabet } from "nanoid";
import { Result } from "better-result";
import type { Kysely, Database, MachineStatus, Machine } from "@hyperfleet/worker/database";
import type { Logger } from "@hyperfleet/logger";
import {
  NotFoundError,
  ValidationError,
  VsockError,
  RuntimeError,
  type HyperfleetError,
} from "@hyperfleet/errors";
import { NetworkManager, type VMNetworkConfig } from "@hyperfleet/network";
import { validateMachinePaths } from "./validation";
import type { CreateMachineBody, MachineResponse, ExecBody, ExecResponse, NetworkConfig } from "../types";
import { RuntimeFactory } from "./runtime-factory";
import { getGlobalRuntimeManager } from "./runtime-manager";

// Global network manager instance
let networkManager: NetworkManager | null = null;

function getNetManager(): NetworkManager {
  if (!networkManager) {
    networkManager = new NetworkManager({
      subnet: "172.16.0.0/24",
      gateway: "172.16.0.1",
      tapPrefix: "hf",
      enableNAT: true,
    });
  }
  return networkManager;
}

const DEFAULT_EXEC_TIMEOUT_SECONDS = 30;
const generateMachineId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

// Default machine configuration from environment variables
const DEFAULT_SOCKET_DIR = process.env.HYPERFLEET_SOCKET_DIR ?? "/tmp";
const DEFAULT_KERNEL_IMAGE_PATH = process.env.HYPERFLEET_KERNEL_IMAGE_PATH ?? "assets/vmlinux";
const DEFAULT_KERNEL_ARGS = process.env.HYPERFLEET_KERNEL_ARGS ?? "console=ttyS0 reboot=k panic=1 pci=off init=/init";
const DEFAULT_ROOTFS_PATH = process.env.HYPERFLEET_ROOTFS_PATH ?? "assets/alpine-rootfs.ext4";

/**
 * Convert a path to absolute if it's relative
 */
function toAbsolutePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${process.cwd()}/${path}`;
}

type MachineConfig = {
  vsock?: {
    uds_path?: string;
    guest_cid?: number;
  };
  exec_port?: number;
  exposedPorts?: number[];
};

function normalizeExposedPorts(
  ports?: number[]
): Result<number[] | undefined, ValidationError> {
  if (!ports || ports.length === 0) {
    return Result.ok(undefined);
  }

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

const isExecResponse = (value: unknown): value is ExecResponse => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.exit_code === "number" &&
    typeof record.stdout === "string" &&
    typeof record.stderr === "string"
  );
};

// Init response format: { success: boolean, data?: {...}, error?: string }
interface InitResponse {
  success: boolean;
  data?: {
    exit_code: number;
    stdout: string;
    stderr: string;
  };
  error?: string;
}

// Vsock port used by the init system
const VSOCK_GUEST_PORT = 52;
const VSOCK_RETRY_ATTEMPTS = 3;
const VSOCK_RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const execViaVsockOnce = (
  udsPath: string,
  payload: { cmd: string[]; timeout: number },
  timeoutMs: number
): Promise<Result<ExecResponse, VsockError>> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ path: udsPath });
    let settled = false;
    let buffer = "";
    let connected = false; // Track if we've completed the CONNECT handshake

    const finish = (err?: VsockError, data?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) {
        resolve(Result.err(err));
        return;
      }
      if (!data) {
        resolve(Result.err(new VsockError({ message: "Empty response from vsock" })));
        return;
      }
      const parseResult = Result.try(() => JSON.parse(data) as InitResponse);
      if (parseResult.isErr()) {
        resolve(Result.err(new VsockError({ message: "Invalid JSON response from vsock" })));
        return;
      }
      const parsed = parseResult.unwrap();
      // Handle init's response format: { success: boolean, data: { exit_code, stdout, stderr } }
      if (!parsed.success) {
        resolve(Result.err(new VsockError({ message: parsed.error ?? "Command failed" })));
        return;
      }
      if (!parsed.data || !isExecResponse(parsed.data)) {
        resolve(Result.err(new VsockError({ message: "Invalid response format from vsock" })));
        return;
      }
      resolve(Result.ok(parsed.data));
    };

    const timer = setTimeout(() => {
      socket.destroy();
      finish(new VsockError({ message: "Vsock timeout" }));
    }, timeoutMs);

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      // Firecracker vsock protocol: send CONNECT <port>\n first
      socket.write(`CONNECT ${VSOCK_GUEST_PORT}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;

      // If we haven't completed the CONNECT handshake yet
      if (!connected) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.startsWith("OK ")) {
            // Connection established, now send the actual request after a small delay
            connected = true;
            const request = { operation: "exec", ...payload };
            setTimeout(() => {
              socket.write(`${JSON.stringify(request)}\n`);
            }, 50);
          } else {
            finish(new VsockError({ message: `Vsock connection failed: ${line}` }));
          }
        }
        return;
      }

      // After connection is established, look for the response
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        finish(undefined, line);
      }
    });

    socket.on("end", () => {
      const remaining = buffer.trim();
      if (!remaining) {
        finish(new VsockError({ message: "Empty response from vsock" }));
        return;
      }
      finish(undefined, remaining);
    });

    socket.on("error", (err) => {
      finish(new VsockError({ message: `Vsock connection error: ${err.message}` }));
    });
  });

/**
 * Execute command via vsock with retry logic
 * Retries help when the guest init hasn't started listening yet
 */
const execViaVsock = async (
  udsPath: string,
  payload: { cmd: string[]; timeout: number },
  timeoutMs: number
): Promise<Result<ExecResponse, VsockError>> => {
  let lastError: VsockError | null = null;

  for (let attempt = 1; attempt <= VSOCK_RETRY_ATTEMPTS; attempt++) {
    const result = await execViaVsockOnce(udsPath, payload, timeoutMs);

    if (result.isOk()) {
      return result;
    }

    lastError = result.error;
    // Only retry on connection errors (like empty response when init isn't ready)
    if (!lastError.message.includes("Empty response") &&
        !lastError.message.includes("connection")) {
      return result; // Don't retry on other errors
    }

    if (attempt < VSOCK_RETRY_ATTEMPTS) {
      await sleep(VSOCK_RETRY_DELAY_MS);
    }
  }

  return Result.err(lastError!);
};

/**
 * Machine service for business logic
 */
export class MachineService {
  constructor(
    private db: Kysely<Database>,
    private logger?: Logger
  ) {}

  /**
   * Convert DB machine to API response
   */
  private toResponse(machine: Machine): MachineResponse {
    const network: NetworkConfig | null =
      machine.tap_device || machine.guest_ip
        ? {
            tap_device: machine.tap_device ?? undefined,
            tap_ip: machine.tap_ip ?? undefined,
            guest_ip: machine.guest_ip ?? undefined,
            guest_mac: machine.guest_mac ?? undefined,
          }
        : null;

    const exposedPorts = this.getExposedPorts(machine);

    return {
      id: machine.id,
      name: machine.name,
      status: machine.status,
      runtime_type: machine.runtime_type,
      vcpu_count: machine.vcpu_count,
      mem_size_mib: machine.mem_size_mib,
      kernel_image_path: machine.kernel_image_path,
      kernel_args: machine.kernel_args,
      rootfs_path: machine.rootfs_path,
      image_ref: machine.image_ref,
      image_digest: machine.image_digest,
      network,
      exposed_ports: exposedPorts,
      pid: machine.pid,
      created_at: machine.created_at,
      updated_at: machine.updated_at,
    };
  }

  private getExposedPorts(machine: Machine): number[] | undefined {
    const configResult = Result.try(() => JSON.parse(machine.config_json) as MachineConfig);
    if (configResult.isErr()) {
      this.logger?.warn("Failed to parse machine config for exposed ports", {
        machineId: machine.id,
        error: configResult.error.message,
      });
      return undefined;
    }

    const normalizeResult = normalizeExposedPorts(configResult.unwrap().exposedPorts);
    if (normalizeResult.isErr()) {
      this.logger?.warn("Invalid exposed ports configuration", {
        machineId: machine.id,
        error: normalizeResult.error.message,
      });
      return undefined;
    }

    return normalizeResult.unwrap();
  }

  /**
   * List all machines, optionally filtered by status
   */
  async list(status?: MachineStatus): Promise<MachineResponse[]> {
    let query = this.db.selectFrom("machines").selectAll();

    if (status) {
      query = query.where("status", "=", status);
    }

    const machines = await query.orderBy("created_at", "desc").execute();
    return machines.map((m: Machine) => this.toResponse(m));
  }

  /**
   * Get a machine by ID
   */
  async get(id: string): Promise<MachineResponse | null> {
    const machine = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return machine ? this.toResponse(machine) : null;
  }

  /**
   * Create a new Firecracker machine
   */
  async create(body: CreateMachineBody): Promise<Result<MachineResponse, HyperfleetError>> {
    const id = generateMachineId();

    // Use paths from environment variables (converted to absolute)
    const inputKernelPath = toAbsolutePath(DEFAULT_KERNEL_IMAGE_PATH);
    // Only use default rootfs if no image is specified
    const inputRootfsPath = body.image ? undefined : toAbsolutePath(DEFAULT_ROOTFS_PATH);

    // Validate kernel path (rootfs is optional when using an image)
    const validationResult = await validateMachinePaths(
      inputKernelPath,
      inputRootfsPath
    );

    if (validationResult.isErr()) {
      return validationResult as Result<never, HyperfleetError>;
    }

    const { kernelPath, rootfsPath } = validationResult.unwrap();
    const socketPath = `${DEFAULT_SOCKET_DIR}/firecracker-${id}.sock`;

    // Auto-allocate network if enabled or not specified and we're on Linux
    let networkConfig: NetworkConfig | undefined = body.network;
    let vmNetwork: VMNetworkConfig | undefined;

    // Check if we should auto-allocate: either network.enable=true or no network config at all
    const shouldAutoAllocate = process.platform === "linux" &&
      (!networkConfig || (networkConfig.enable && !networkConfig.tap_device));

    if (shouldAutoAllocate) {
      const netManager = getNetManager();
      const allocResult = await netManager.allocateNetwork(id);
      if (allocResult.isOk()) {
        vmNetwork = allocResult.unwrap();
        networkConfig = {
          tap_device: vmNetwork.tapDevice,
          tap_ip: vmNetwork.hostIp,
          guest_ip: vmNetwork.ip,
          guest_mac: vmNetwork.mac,
        };
        this.logger?.info("Auto-allocated network for machine", {
          machineId: id,
          ip: vmNetwork.ip,
          tap: vmNetwork.tapDevice,
        });
      } else {
        this.logger?.warn("Failed to auto-allocate network", {
          machineId: id,
          error: allocResult.error.message,
        });
      }
    }

    // Build kernel args with network configuration if available
    let kernelArgs = DEFAULT_KERNEL_ARGS;
    if (vmNetwork?.kernelArgs) {
      kernelArgs = `${kernelArgs} ${vmNetwork.kernelArgs}`;
    }

    const exposedPortsResult = normalizeExposedPorts(body.exposed_ports);
    if (exposedPortsResult.isErr()) {
      return Result.err(exposedPortsResult.error);
    }

    // Build drives array for non-OCI case (OCI images use ResolveImageHandler)
    const drives = rootfsPath
      ? [
          {
            drive_id: "rootfs",
            path_on_host: rootfsPath,
            is_root_device: true,
            is_read_only: false,
          },
        ]
      : undefined;

    // Vsock configuration for guest communication
    const vsockUdsPath = `${DEFAULT_SOCKET_DIR}/hyperfleet-${id}.vsock`;
    const vsock = {
      guest_cid: 3,
      uds_path: vsockUdsPath,
    };

    // Build machine config with OCI image support
    const config = {
      socketPath,
      kernelImagePath: kernelPath,
      kernelArgs,
      vcpuCount: body.vcpu_count,
      memSizeMib: body.mem_size_mib,
      exposedPorts: exposedPortsResult.unwrap(),
      // Drives (for non-OCI case, OCI images use ResolveImageHandler)
      drives,
      // OCI image configuration (will be resolved by ResolveImageHandler)
      imageRef: body.image,
      imageSizeMib: body.image_size_mib,
      registryAuth: body.registry_auth,
      // Vsock for guest communication
      vsock,
      // Add network interfaces if configured
      networkInterfaces: networkConfig?.tap_device
        ? [
            {
              iface_id: "eth0",
              host_dev_name: networkConfig.tap_device,
              guest_mac: networkConfig.guest_mac,
            },
          ]
        : undefined,
    };

    await this.db
      .insertInto("machines")
      .values({
        id,
        name: body.name,
        status: "pending",
        runtime_type: "firecracker",
        vcpu_count: body.vcpu_count,
        mem_size_mib: body.mem_size_mib,
        kernel_image_path: kernelPath,
        kernel_args: kernelArgs,
        rootfs_path: rootfsPath ?? null,
        socket_path: socketPath,
        tap_device: networkConfig?.tap_device ?? null,
        tap_ip: networkConfig?.tap_ip ?? null,
        guest_ip: networkConfig?.guest_ip ?? null,
        guest_mac: networkConfig?.guest_mac ?? null,
        image_ref: body.image ?? null,
        image_digest: null, // Will be populated after start() resolves the image
        config_json: JSON.stringify(config),
      })
      .execute();

    const machine = await this.get(id);
    return Result.ok(machine!);
  }

  /**
   * Delete a machine
   */
  async delete(id: string): Promise<boolean> {
    // Get machine to check if it exists
    const machine = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!machine) {
      return false;
    }

    // Release network allocation
    const netManager = getNetManager();
    const releaseResult = await netManager.releaseNetwork(id);
    if (releaseResult.isErr()) {
      this.logger?.warn("Failed to release network", {
        machineId: id,
        error: releaseResult.error.message,
      });
    }

    const result = await this.db
      .deleteFrom("machines")
      .where("id", "=", id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Update machine status
   */
  async updateStatus(
    id: string,
    status: MachineStatus,
    updates?: { pid?: number | null; error_message?: string | null }
  ): Promise<MachineResponse | null> {
    await this.db
      .updateTable("machines")
      .set({
        status,
        pid: updates?.pid,
        error_message: updates?.error_message,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .execute();

    return this.get(id);
  }

  /**
   * Start a machine - spawns the actual runtime process
   */
  async start(id: string): Promise<Result<MachineResponse, HyperfleetError>> {
    // Get the raw machine record from DB (not the response format)
    const machineRecord = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!machineRecord) {
      return Result.err(new NotFoundError({ message: "Machine not found" }));
    }

    if (machineRecord.status === "running") {
      this.logger?.info("Machine already running", { machineId: id });
      return Result.ok(this.toResponse(machineRecord));
    }

    // Update status to starting
    await this.updateStatus(id, "starting");
    this.logger?.info("Starting machine", {
      machineId: id,
      runtime: machineRecord.runtime_type,
    });

    return Result.tryPromise({
      try: async () => {
        // Create runtime instance from stored config
        const factory = new RuntimeFactory(this.logger);
        const runtime = factory.createFromMachine(machineRecord);

        // Start the runtime (spawns actual process)
        const startResult = await runtime.start();
        if (startResult.isErr()) {
          throw startResult.error;
        }

        // Get the PID
        const pid = runtime.getPid();

        // Register in the global runtime manager for later operations
        const runtimeManager = getGlobalRuntimeManager(this.logger);
        runtimeManager.register(id, runtime);

        // Update DB with running status and PID
        const updated = await this.updateStatus(id, "running", {
          pid: pid,
        });

        this.logger?.info("Machine started successfully", { machineId: id, pid });
        return updated!;
      },
      catch: async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error("Failed to start machine", {
          machineId: id,
          error: message,
        });

        await this.updateStatus(id, "failed", { error_message: message });
        return new RuntimeError({ message, cause: error });
      },
    });
  }

  /**
   * Stop a machine - stops the actual runtime process
   * Note: This always succeeds (graceful degradation) - errors are logged but don't fail the operation
   */
  async stop(id: string): Promise<Result<MachineResponse, NotFoundError>> {
    const machine = await this.get(id);
    if (!machine) {
      return Result.err(new NotFoundError({ message: "Machine not found" }));
    }

    if (machine.status === "stopped") {
      this.logger?.info("Machine already stopped", { machineId: id });
      return Result.ok(machine);
    }

    // Update status to stopping
    await this.updateStatus(id, "stopping");
    this.logger?.info("Stopping machine", { machineId: id });

    const runtimeManager = getGlobalRuntimeManager(this.logger);
    const runtime = runtimeManager.get(id);

    if (runtime) {
      // Graceful shutdown with 3 second timeout
      const shutdownResult = await runtime.shutdown(3000);

      if (shutdownResult.isErr()) {
        this.logger?.error("Error during shutdown, forcing stop", {
          machineId: id,
          error: shutdownResult.error.message,
        });
      }

      runtimeManager.remove(id);
      this.logger?.info("Machine stopped successfully", { machineId: id });
    } else {
      this.logger?.warn("No runtime instance found, marking as stopped", {
        machineId: id,
      });
    }

    const updated = await this.updateStatus(id, "stopped", { pid: null });
    return Result.ok(updated!);
  }

  /**
   * Restart a machine
   */
  async restart(id: string): Promise<Result<MachineResponse, HyperfleetError>> {
    const machine = await this.get(id);
    if (!machine) {
      return Result.err(new NotFoundError({ message: "Machine not found" }));
    }

    // Use stop+start for VM runtimes
    const stopResult = await this.stop(id);
    if (stopResult.isErr()) {
      return stopResult;
    }
    return this.start(id);
  }

  /**
   * Execute a command on a machine via vsock
   */
  async exec(
    id: string,
    body: ExecBody
  ): Promise<Result<ExecResponse, HyperfleetError>> {
    const machine = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!machine) {
      return Result.err(new NotFoundError({ message: "Machine not found" }));
    }

    if (machine.status !== "running") {
      return Result.err(new ValidationError({ message: "Machine must be running to execute commands" }));
    }

    const timeoutSeconds = Math.max(1, body.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS);
    const timeoutMs = timeoutSeconds * 1000;

    // Use vsock for command execution
    const configResult = Result.try(() => JSON.parse(machine.config_json) as MachineConfig);
    const config = configResult.unwrapOr(null);
    const udsPath = config?.vsock?.uds_path;

    if (!udsPath) {
      return Result.err(new VsockError({ message: "Vsock not configured for this machine" }));
    }

    return execViaVsock(udsPath, { cmd: body.cmd, timeout: timeoutSeconds }, timeoutMs);
  }
}
