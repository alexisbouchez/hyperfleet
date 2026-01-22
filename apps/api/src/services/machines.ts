import net from "node:net";
import { customAlphabet } from "nanoid";
import { Result } from "better-result";
import type { Kysely, Database, MachineStatus, Machine, RuntimeType } from "@hyperfleet/worker/database";
import type { Logger } from "@hyperfleet/logger";
import {
  NotFoundError,
  ValidationError,
  VsockError,
  RuntimeError,
  type HyperfleetError,
} from "@hyperfleet/errors";
import { NetworkManager, type VMNetworkConfig } from "@hyperfleet/network";
import { validateMachinePaths, sanitizePath } from "./validation";
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

const execViaVsock = (
  udsPath: string,
  payload: { cmd: string[]; timeout: number },
  timeoutMs: number
): Promise<Result<ExecResponse, VsockError>> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ path: udsPath });
    let settled = false;
    let buffer = "";

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
      const parseResult = Result.try(() => JSON.parse(data));
      if (parseResult.isErr()) {
        resolve(Result.err(new VsockError({ message: "Invalid JSON response from vsock" })));
        return;
      }
      const parsed = parseResult.unwrap();
      if (!isExecResponse(parsed)) {
        resolve(Result.err(new VsockError({ message: "Invalid response format from vsock" })));
        return;
      }
      resolve(Result.ok(parsed));
    };

    const timer = setTimeout(() => {
      socket.destroy();
      finish(new VsockError({ message: "Vsock timeout" }));
    }, timeoutMs);

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.end(`${JSON.stringify(payload)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
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
      network,
      exposed_ports: exposedPorts,
      image: machine.image,
      container_id: machine.container_id,
      pid: machine.pid,
      created_at: machine.created_at,
      updated_at: machine.updated_at,
    };
  }

  private getExposedPorts(machine: Machine): number[] | undefined {
    if (machine.runtime_type === "docker") {
      return undefined;
    }

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
   * List all machines, optionally filtered by status and runtime_type
   */
  async list(status?: MachineStatus, runtimeType?: RuntimeType): Promise<MachineResponse[]> {
    let query = this.db.selectFrom("machines").selectAll();

    if (status) {
      query = query.where("status", "=", status);
    }

    if (runtimeType) {
      query = query.where("runtime_type", "=", runtimeType);
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
   * Create a new machine (supports Firecracker, Docker, and Cloud Hypervisor)
   */
  async create(body: CreateMachineBody): Promise<Result<MachineResponse, HyperfleetError>> {
    const id = generateMachineId();
    const runtimeType: RuntimeType = body.runtime_type || "firecracker";

    if (runtimeType === "docker") {
      return this.createDockerMachine(id, body);
    }

    if (runtimeType === "cloud-hypervisor") {
      return this.createCloudHypervisorMachine(id, body);
    }

    return this.createFirecrackerMachine(id, body);
  }

  /**
   * Create a new Firecracker machine
   */
  private async createFirecrackerMachine(
    id: string,
    body: CreateMachineBody
  ): Promise<Result<MachineResponse, HyperfleetError>> {
    // Validate kernel and rootfs paths
    const validationResult = await validateMachinePaths(
      body.kernel_image_path,
      body.rootfs_path
    );

    if (validationResult.isErr()) {
      return validationResult as Result<never, HyperfleetError>;
    }

    const { kernelPath, rootfsPath } = validationResult.unwrap();
    const socketPath = `/tmp/firecracker-${id}.sock`;

    // Auto-allocate network if not specified and we're on Linux
    let networkConfig: NetworkConfig | undefined = body.network;
    let vmNetwork: VMNetworkConfig | undefined;

    if (!networkConfig && process.platform === "linux") {
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
    let kernelArgs = body.kernel_args ?? "console=ttyS0 reboot=k panic=1 pci=off";
    if (vmNetwork?.kernelArgs) {
      kernelArgs = `${kernelArgs} ${vmNetwork.kernelArgs}`;
    }

    const exposedPortsResult = normalizeExposedPorts(body.exposed_ports);
    if (exposedPortsResult.isErr()) {
      return Result.err(exposedPortsResult.error);
    }

    const config = {
      socketPath,
      kernelImagePath: kernelPath,
      kernelArgs,
      rootfsPath: rootfsPath,
      vcpuCount: body.vcpu_count,
      memSizeMib: body.mem_size_mib,
      exposedPorts: exposedPortsResult.unwrap(),
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
        image: null,
        container_id: null,
        config_json: JSON.stringify(config),
      })
      .execute();

    const machine = await this.get(id);
    return Result.ok(machine!);
  }

  /**
   * Create a new Docker container
   */
  private async createDockerMachine(
    id: string,
    body: CreateMachineBody
  ): Promise<Result<MachineResponse, HyperfleetError>> {
    if (!body.image) {
      return Result.err(
        new ValidationError({ message: "image is required for Docker runtime" })
      );
    }

    // Validate volume host paths for path traversal
    if (body.volumes) {
      for (const volume of body.volumes) {
        const pathResult = sanitizePath(volume.host_path);
        if (pathResult.isErr()) {
          return pathResult as Result<never, HyperfleetError>;
        }
      }
    }

    const config = {
      id,
      name: `hyperfleet-${id}`,
      image: body.image,
      cmd: body.cmd,
      entrypoint: body.entrypoint,
      cpus: body.vcpu_count,
      memoryMib: body.mem_size_mib,
      env: body.env,
      ports: body.ports?.map((p) => ({
        hostPort: p.host_port,
        containerPort: p.container_port,
        protocol: p.protocol,
      })),
      volumes: body.volumes?.map((v) => ({
        hostPath: v.host_path,
        containerPath: v.container_path,
        readOnly: v.read_only,
      })),
      workingDir: body.working_dir,
      user: body.user,
      privileged: body.privileged,
      restart: body.restart,
    };

    await this.db
      .insertInto("machines")
      .values({
        id,
        name: body.name,
        status: "pending",
        runtime_type: "docker",
        vcpu_count: body.vcpu_count,
        mem_size_mib: body.mem_size_mib,
        kernel_image_path: "", // Not used for Docker
        kernel_args: null,
        rootfs_path: null,
        socket_path: "", // Not used for Docker
        tap_device: null,
        tap_ip: null,
        guest_ip: null,
        guest_mac: null,
        image: body.image,
        container_id: null,
        config_json: JSON.stringify(config),
      })
      .execute();

    const machine = await this.get(id);
    return Result.ok(machine!);
  }

  /**
   * Create a new Cloud Hypervisor machine
   */
  private async createCloudHypervisorMachine(
    id: string,
    body: CreateMachineBody
  ): Promise<Result<MachineResponse, HyperfleetError>> {
    // Validate kernel and rootfs paths
    const validationResult = await validateMachinePaths(
      body.kernel_image_path,
      body.rootfs_path
    );

    if (validationResult.isErr()) {
      return validationResult as Result<never, HyperfleetError>;
    }

    const { kernelPath, rootfsPath } = validationResult.unwrap();
    const socketPath = `/tmp/cloud-hypervisor-${id}.sock`;

    // Auto-allocate network if not specified and we're on Linux
    let networkConfig: NetworkConfig | undefined = body.network;
    let vmNetwork: VMNetworkConfig | undefined;

    if (!networkConfig && process.platform === "linux") {
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
    let kernelArgs = body.kernel_args ?? "console=ttyS0 root=/dev/vda rw";
    if (vmNetwork?.kernelArgs) {
      kernelArgs = `${kernelArgs} ${vmNetwork.kernelArgs}`;
    }

    const exposedPortsResult = normalizeExposedPorts(body.exposed_ports);
    if (exposedPortsResult.isErr()) {
      return Result.err(exposedPortsResult.error);
    }

    const config = {
      socketPath,
      payload: {
        kernel: kernelPath,
        cmdline: kernelArgs,
      },
      cpus: {
        boot_vcpus: body.vcpu_count,
        max_vcpus: body.vcpu_count,
      },
      memory: {
        size: body.mem_size_mib * 1024 * 1024, // Convert MiB to bytes
      },
      disks: rootfsPath
        ? [
            {
              path: rootfsPath,
              readonly: false,
            },
          ]
        : undefined,
      net: networkConfig?.tap_device
        ? [
            {
              tap: networkConfig.tap_device,
              ip: networkConfig.tap_ip,
              mac: networkConfig.guest_mac,
            },
          ]
        : undefined,
      exposedPorts: exposedPortsResult.unwrap(),
    };

    await this.db
      .insertInto("machines")
      .values({
        id,
        name: body.name,
        status: "pending",
        runtime_type: "cloud-hypervisor",
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
        image: null,
        container_id: null,
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
    // Get machine to check runtime type
    const machine = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!machine) {
      return false;
    }

    // Release network allocation for VM-based runtimes
    if (machine.runtime_type === "firecracker" || machine.runtime_type === "cloud-hypervisor") {
      const netManager = getNetManager();
      const releaseResult = await netManager.releaseNetwork(id);
      if (releaseResult.isErr()) {
        this.logger?.warn("Failed to release network", {
          machineId: id,
          error: releaseResult.error.message,
        });
      }
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
        await runtime.start();

        // Get the PID/container ID
        const pid = runtime.getPid();

        // Register in the global runtime manager for later operations
        const runtimeManager = getGlobalRuntimeManager(this.logger);
        runtimeManager.register(id, runtime);

        // Update DB with running status and PID
        const updated = await this.updateStatus(id, "running", {
          pid: typeof pid === "number" ? pid : null,
        });

        // For Docker, also store the container ID
        if (machineRecord.runtime_type === "docker" && typeof pid === "string") {
          await this.db
            .updateTable("machines")
            .set({ container_id: pid })
            .where("id", "=", id)
            .execute();
        }

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
      // Graceful shutdown with 3 second timeout - catch errors but don't fail
      const shutdownResult = await Result.tryPromise({
        try: async () => {
          await runtime.shutdown(3000);
        },
        catch: (error) => error,
      });

      if (shutdownResult.isErr()) {
        const message = shutdownResult.error instanceof Error
          ? shutdownResult.error.message
          : String(shutdownResult.error);
        this.logger?.error("Error during shutdown, forcing stop", {
          machineId: id,
          error: message,
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

    // For Docker containers, use the runtime's restart method directly
    // This avoids container name conflicts from stop+start
    if (machine.runtime_type === "docker") {
      const runtimeManager = getGlobalRuntimeManager(this.logger);
      const runtime = runtimeManager.get(id);

      if (!runtime) {
        return Result.err(new RuntimeError({ message: "Runtime not found - is the container running?" }));
      }

      this.logger?.info("Restarting machine", { machineId: id });

      return Result.tryPromise({
        try: async () => {
          // Use short restart timeout (2s graceful, then force)
          await runtime.restart(2);
          this.logger?.info("Machine restarted successfully", { machineId: id });
          return (await this.get(id))!;
        },
        catch: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger?.error("Failed to restart machine", { machineId: id, error: message });
          return new RuntimeError({ message: `Restart failed: ${message}`, cause: error });
        },
      });
    }

    // For VM runtimes, use stop+start
    const stopResult = await this.stop(id);
    if (stopResult.isErr()) {
      return stopResult;
    }
    return this.start(id);
  }

  /**
   * Execute a command on a machine
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

    // For Docker containers, use the runtime's exec method directly
    if (machine.runtime_type === "docker") {
      const runtimeManager = getGlobalRuntimeManager(this.logger);
      const runtime = runtimeManager.get(id);

      if (!runtime) {
        return Result.err(new RuntimeError({ message: "Runtime not found - is the container running?" }));
      }

      return Result.tryPromise({
        try: async () => {
          const result = await runtime.exec(body.cmd, timeoutMs);
          return result;
        },
        catch: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          return new RuntimeError({ message: `Exec failed: ${message}`, cause: error });
        },
      });
    }

    // For VM runtimes, use vsock
    const configResult = Result.try(() => JSON.parse(machine.config_json) as MachineConfig);
    const config = configResult.unwrapOr(null);
    const udsPath = config?.vsock?.uds_path;

    if (!udsPath) {
      return Result.err(new VsockError({ message: "Vsock not configured for this machine" }));
    }

    return execViaVsock(udsPath, { cmd: body.cmd, timeout: timeoutSeconds }, timeoutMs);
  }
}
