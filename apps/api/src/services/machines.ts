import net from "node:net";
import { nanoid } from "nanoid";
import type { Kysely, Database, MachineStatus, Machine, RuntimeType } from "@hyperfleet/worker/database";
import type { CreateMachineBody, MachineResponse, ExecBody, ExecResponse, NetworkConfig } from "../types";

const DEFAULT_EXEC_TIMEOUT_SECONDS = 30;

type MachineConfig = {
  vsock?: {
    uds_path?: string;
    guest_cid?: number;
  };
  exec_port?: number;
};

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
): Promise<ExecResponse> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: udsPath });
    let settled = false;
    let buffer = "";

    const finish = (err?: Error, data?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (err) {
        reject(err);
        return;
      }
      if (!data) {
        reject(new Error("vsock_empty_response"));
        return;
      }
      const parsed = safeJsonParse(data);
      if (!isExecResponse(parsed)) {
        reject(new Error("vsock_invalid_response"));
        return;
      }
      resolve(parsed);
    };

    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("vsock_timeout"));
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
        finish(new Error("vsock_empty_response"));
        return;
      }
      finish(undefined, remaining);
    });

    socket.on("error", (err) => {
      finish(err);
    });
  });

/**
 * Machine service for business logic
 */
export class MachineService {
  constructor(private db: Kysely<Database>) {}

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
  async create(body: CreateMachineBody): Promise<MachineResponse> {
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
  private async createFirecrackerMachine(id: string, body: CreateMachineBody): Promise<MachineResponse> {
    const socketPath = `/tmp/firecracker-${id}.sock`;

    const config = {
      socketPath,
      kernelImagePath: body.kernel_image_path,
      kernelArgs: body.kernel_args,
      rootfsPath: body.rootfs_path,
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
        kernel_image_path: body.kernel_image_path,
        kernel_args: body.kernel_args ?? null,
        rootfs_path: body.rootfs_path ?? null,
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
    return machine!;
  }

  /**
   * Create a new Docker container
   */
  private async createDockerMachine(id: string, body: CreateMachineBody): Promise<MachineResponse> {
    if (!body.image) {
      throw new Error("image is required for Docker runtime");
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
      ports: body.ports?.map(p => ({
        hostPort: p.host_port,
        containerPort: p.container_port,
        protocol: p.protocol,
      })),
      volumes: body.volumes?.map(v => ({
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
    return machine!;
  }

  /**
   * Create a new Cloud Hypervisor machine
   */
  private async createCloudHypervisorMachine(id: string, body: CreateMachineBody): Promise<MachineResponse> {
    const socketPath = `/tmp/cloud-hypervisor-${id}.sock`;

    const config = {
      socketPath,
      payload: {
        kernel: body.kernel_image_path,
        cmdline: body.kernel_args,
      },
      cpus: {
        boot_vcpus: body.vcpu_count,
        max_vcpus: body.vcpu_count,
      },
      memory: {
        size: body.mem_size_mib * 1024 * 1024, // Convert MiB to bytes
      },
      disks: body.rootfs_path ? [{
        path: body.rootfs_path,
        readonly: false,
      }] : undefined,
      net: body.network?.tap_device ? [{
        tap: body.network.tap_device,
        ip: body.network.tap_ip,
        mac: body.network.guest_mac,
      }] : undefined,
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
        kernel_image_path: body.kernel_image_path,
        kernel_args: body.kernel_args ?? null,
        rootfs_path: body.rootfs_path ?? null,
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
    return machine!;
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
   * Start a machine
   */
  async start(id: string): Promise<MachineResponse | null> {
    const machine = await this.get(id);
    if (!machine) return null;

    if (machine.status === "running") {
      return machine;
    }

    // Update status to starting
    await this.updateStatus(id, "starting");

    // TODO: Actually spawn Firecracker process here
    // For now, just simulate by setting to running
    // In production, this would:
    // 1. Create Machine instance from @hyperfleet/firecracker
    // 2. Call machine.start()
    // 3. Store the PID

    // Simulate starting (placeholder)
    return this.updateStatus(id, "running", { pid: null });
  }

  /**
   * Stop a machine
   */
  async stop(id: string): Promise<MachineResponse | null> {
    const machine = await this.get(id);
    if (!machine) return null;

    if (machine.status === "stopped") {
      return machine;
    }

    // Update status to stopping
    await this.updateStatus(id, "stopping");

    // TODO: Actually stop Firecracker process here
    // In production, this would:
    // 1. Get Machine instance
    // 2. Call machine.shutdown()

    // Simulate stopping
    return this.updateStatus(id, "stopped", { pid: null });
  }

  /**
   * Restart a machine
   */
  async restart(id: string): Promise<MachineResponse | null> {
    await this.stop(id);
    return this.start(id);
  }

  /**
   * Execute a command on a machine
   */
  async exec(
    id: string,
    body: ExecBody
  ): Promise<{ success: true; result: ExecResponse } | { success: false; error: string }> {
    const machine = await this.db
      .selectFrom("machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!machine) {
      return { success: false, error: "not_found" };
    }

    if (machine.status !== "running") {
      return { success: false, error: "machine_not_running" };
    }

    const config = safeJsonParse(machine.config_json) as MachineConfig | null;
    const udsPath = config?.vsock?.uds_path;
    if (!udsPath) {
      return { success: false, error: "vsock_not_configured" };
    }

    const timeoutSeconds = Math.max(1, body.timeout ?? DEFAULT_EXEC_TIMEOUT_SECONDS);
    const timeoutMs = timeoutSeconds * 1000;

    try {
      const result = await execViaVsock(udsPath, { cmd: body.cmd, timeout: timeoutSeconds }, timeoutMs);
      return { success: true, result };
    } catch {
      return { success: false, error: "exec_failed" };
    }
  }
}
