import net from "node:net";
import { nanoid } from "nanoid";
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
import { validateMachinePaths, sanitizePath } from "./validation";
import type { CreateMachineBody, MachineResponse, ExecBody, ExecResponse, NetworkConfig } from "../types";
import { RuntimeFactory } from "./runtime-factory";
import { getGlobalRuntimeManager } from "./runtime-manager";

const DEFAULT_EXEC_TIMEOUT_SECONDS = 30;

type MachineConfig = {
  vsock?: {
    uds_path?: string;
    guest_cid?: number;
  };
  exec_port?: number;
};

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
      image: machine.image,
      container_id: machine.container_id,
      pid: machine.pid,
      created_at: machine.created_at,
      updated_at: machine.updated_at,
    };
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
    const id = nanoid(12);
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

    const config = {
      socketPath,
      kernelImagePath: kernelPath,
      kernelArgs: body.kernel_args,
      rootfsPath: rootfsPath,
      vcpuCount: body.vcpu_count,
      memSizeMib: body.mem_size_mib,
      network: body.network,
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
        kernel_args: body.kernel_args ?? null,
        rootfs_path: rootfsPath ?? null,
        socket_path: socketPath,
        tap_device: body.network?.tap_device ?? null,
        tap_ip: body.network?.tap_ip ?? null,
        guest_ip: body.network?.guest_ip ?? null,
        guest_mac: body.network?.guest_mac ?? null,
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

    const config = {
      socketPath,
      payload: {
        kernel: kernelPath,
        cmdline: body.kernel_args,
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
      net: body.network?.tap_device
        ? [
            {
              tap: body.network.tap_device,
              ip: body.network.tap_ip,
              mac: body.network.guest_mac,
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
        runtime_type: "cloud-hypervisor",
        vcpu_count: body.vcpu_count,
        mem_size_mib: body.mem_size_mib,
        kernel_image_path: kernelPath,
        kernel_args: body.kernel_args ?? null,
        rootfs_path: rootfsPath ?? null,
        socket_path: socketPath,
        tap_device: body.network?.tap_device ?? null,
        tap_ip: body.network?.tap_ip ?? null,
        guest_ip: body.network?.guest_ip ?? null,
        guest_mac: body.network?.guest_mac ?? null,
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
      // Graceful shutdown with 10 second timeout - catch errors but don't fail
      const shutdownResult = await Result.tryPromise({
        try: async () => {
          await runtime.shutdown(10000);
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

    const configResult = Result.try(() => JSON.parse(machine.config_json) as MachineConfig);
    const config = configResult.unwrapOr(null);
    const udsPath = config?.vsock?.uds_path;

    if (!udsPath) {
      return Result.err(new VsockError({ message: "Vsock not configured for this machine" }));
    }

    const timeoutSeconds = Math.max(1, body.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS);
    const timeoutMs = timeoutSeconds * 1000;

    return execViaVsock(udsPath, { cmd: body.cmd, timeout: timeoutSeconds }, timeoutMs);
  }
}
