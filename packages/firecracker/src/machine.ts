/**
 * High-level Machine abstraction for Firecracker microVMs
 * Similar to firecracker-go-sdk's Machine struct
 */

import { Result } from "better-result";
import type { Subprocess } from "bun";
import type { Runtime, RuntimeInfo, ExecResult } from "@hyperfleet/runtime";
import { FirecrackerClient } from "./client";
import type {
  Drive,
  NetworkInterface,
  Vsock,
  Balloon,
  MmdsConfig,
  MmdsContentsObject,
  SnapshotCreateParams,
  SnapshotLoadParams,
  CpuTemplate,
  Logger,
  InstanceInfo,
  BalloonStats,
} from "./models";
import { Handlers, createDefaultHandlers } from "./handlers";
import type { JailerConfig } from "./jailer";
import { buildJailerArgs, getJailerChrootPath } from "./jailer";

/**
 * Registry authentication credentials for OCI images
 */
export interface RegistryAuth {
  username: string;
  password: string;
}

export interface MachineConfig {
  // Socket path for Firecracker API
  socketPath: string;

  // Kernel configuration
  kernelImagePath: string;
  kernelArgs?: string;
  initrdPath?: string;

  // Machine configuration
  vcpuCount: number;
  memSizeMib: number;
  smt?: boolean;
  cpuTemplate?: CpuTemplate;
  trackDirtyPages?: boolean;

  // Drives
  drives?: Drive[];

  // OCI Image support
  /** OCI image reference (e.g., "alpine:latest") */
  imageRef?: string;
  /** Size of generated rootfs in MiB (default: 1024) */
  imageSizeMib?: number;
  /** Registry authentication for private images */
  registryAuth?: RegistryAuth;

  // Network
  networkInterfaces?: NetworkInterface[];

  // Vsock
  vsock?: Vsock;

  // Balloon
  balloon?: Balloon;

  // MMDS
  mmdsConfig?: MmdsConfig;
  mmdsData?: MmdsContentsObject;

  // Logging
  logPath?: string;
  logLevel?: Logger["level"];
  metricsPath?: string;

  // Jailer (optional)
  jailer?: JailerConfig;

  // Firecracker binary path
  firecrackerBinary?: string;
}

export type MachineOpt = (machine: Machine) => void;

export function withClient(client: FirecrackerClient): MachineOpt {
  return (machine) => {
    machine.client = client;
  };
}

export function withHandlers(handlers: Handlers): MachineOpt {
  return (machine) => {
    machine.handlers = handlers;
  };
}

export class Machine implements Runtime {
  readonly type = "firecracker" as const;
  readonly config: MachineConfig;
  client: FirecrackerClient;
  handlers: Handlers;

  private process: Subprocess | null = null;
  private started = false;
  private _pid: number | null = null;

  constructor(config: MachineConfig, ...opts: MachineOpt[]) {
    this.config = config;
    this.client = new FirecrackerClient({ socketPath: config.socketPath });
    this.handlers = createDefaultHandlers();

    for (const opt of opts) {
      opt(this);
    }
  }

  /**
   * Get the unique identifier for this machine
   */
  get id(): string {
    // Extract ID from socket path or use socket path as ID
    const match = this.config.socketPath.match(/firecracker-([^.]+)\.sock/);
    return match ? match[1] : this.config.socketPath;
  }

  /**
   * Get kernel boot arguments including any network configuration
   */
  getKernelArgs(): string {
    const args: string[] = [];

    if (this.config.kernelArgs) {
      args.push(this.config.kernelArgs);
    }

    return args.join(" ");
  }

  /**
   * Start the Firecracker VMM process
   */
  async startVMM(): Promise<Result<void, Error>> {
    const args: string[] = [];

    try {
      if (this.config.jailer) {
        // Use jailer
        const jailerArgs = buildJailerArgs({
          config: this.config.jailer,
          socketPath: this.config.socketPath,
        });
        const jailerBinary = this.config.jailer.jailerBinary || "jailer";

        this.process = Bun.spawn([jailerBinary, ...jailerArgs], {
          stdio: ["inherit", "inherit", "inherit"],
        });
      } else {
        // Direct firecracker execution
        const binary = this.config.firecrackerBinary || "firecracker";
        args.push("--api-sock", this.config.socketPath);

        this.process = Bun.spawn([binary, ...args], {
          stdio: ["inherit", "inherit", "inherit"],
        });
      }
    } catch (err) {
      return Result.err(err instanceof Error ? err : new Error(String(err)));
    }

    this._pid = this.process.pid;

    // Wait for socket to be ready
    return await this.waitForSocket();
  }

  private async waitForSocket(timeoutMs = 15000): Promise<Result<void, Error>> {
    const start = Date.now();
    const socketPath = this.config.jailer
      ? `${getJailerChrootPath(this.config.jailer)}/${this.config.socketPath}`
      : this.config.socketPath;

    while (Date.now() - start < timeoutMs) {
      try {
        // Try to connect directly - Bun.file().exists() doesn't work for sockets
        const result = await this.client.describeInstance();
        if (result.isOk()) return Result.ok(undefined);
      } catch {
        // Socket not ready yet
      }
      await Bun.sleep(100);
    }

    return Result.err(new Error(`Timeout waiting for Firecracker socket at ${socketPath}`));
  }

  /**
   * Start the microVM using the handler chain
   */
  async start(): Promise<Result<void, Error>> {
    if (this.started) {
      return Result.err(new Error("Machine already started"));
    }

    // Run validation handlers
    const valRes = await this.handlers.validation.run(this);
    if (valRes.isErr()) return valRes;

    // Start VMM process if not using external process
    if (!this.process) {
      const vmmRes = await this.startVMM();
      if (vmmRes.isErr()) return vmmRes;
    }

    // Run initialization handlers
    const initRes = await this.handlers.fcInit.run(this);
    if (initRes.isErr()) return initRes;

    this.started = true;
    return Result.ok(undefined);
  }

  /**
   * Pause the microVM
   */
  async pause(): Promise<Result<void, Error>> {
    return await this.client.patchVm("Paused");
  }

  /**
   * Resume a paused microVM
   */
  async resume(): Promise<Result<void, Error>> {
    return await this.client.patchVm("Resumed");
  }

  /**
   * Send Ctrl+Alt+Del to the guest (graceful shutdown)
   */
  async sendCtrlAltDel(): Promise<Result<void, Error>> {
    return await this.client.createSyncAction("SendCtrlAltDel");
  }

  /**
   * Stop the microVM
   */
  async stop(): Promise<Result<void, Error>> {
    if (this.process) {
      this.process.kill();
      await this.process.exited;
      this.process = null;
    }
    return Result.ok(undefined);
  }

  /**
   * Shutdown the microVM gracefully, then force kill if needed
   */
  async shutdown(timeoutMs = 5000): Promise<Result<void, Error>> {
    if (!this.process) {
      return Result.ok(undefined);
    }

    // Try graceful shutdown first
    const cadResult = await this.sendCtrlAltDel();
    if (cadResult.isErr()) {
      // Failed to send ctrl+alt+del, force kill
      return await this.stop();
    }

    // Wait for process to exit
    const exitPromise = this.process.exited;
    const timeoutPromise = Bun.sleep(timeoutMs).then(() => null);

    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (result === null) {
      // Timeout, force kill
      return await this.stop();
    }
    
    return Result.ok(undefined);
  }

  /**
   * Restart the microVM
   */
  async restart(timeoutSeconds = 5): Promise<Result<void, Error>> {
    const shutdownRes = await this.shutdown(timeoutSeconds * 1000);
    if (shutdownRes.isErr()) return shutdownRes;
    
    return await this.start();
  }

  /**
   * Get the PID of the Firecracker process
   */
  getPid(): number | null {
    return this._pid;
  }

  /**
   * Check if the machine is running
   */
  isRunning(): boolean {
    return this.started && this.process !== null;
  }

  /**
   * Get runtime information (implements Runtime interface)
   */
  async getInfo(): Promise<Result<RuntimeInfo, Error>> {
    const infoRes = await this.getInstanceInfo();
    if (infoRes.isErr()) return Result.err(infoRes.error);
    
    const info = infoRes.unwrap();
    return Result.ok({
      id: this.id,
      status: info.state === "Running" ? "running" : info.state === "Paused" ? "paused" : "stopped",
      pid: this._pid,
    });
  }

  /**
   * Get Firecracker instance info
   */
  async getInstanceInfo(): Promise<Result<InstanceInfo, Error>> {
    return await this.client.describeInstance();
  }

  /**
   * Execute a command in the VM via vsock (implements Runtime interface)
   */
  async exec(cmd: string[], timeoutMs = 30000): Promise<Result<ExecResult, Error>> {
    const { vsock } = this.config;
    if (!vsock?.uds_path) {
      return Result.err(new Error("Vsock not configured - cannot execute commands"));
    }

    try {
      // Dynamic import to avoid top-level import issues
      const net = await import("node:net");

      return new Promise((resolve) => {
        const socket = net.createConnection({ path: vsock.uds_path! });
        let settled = false;
        let buffer = "";

        const finish = (err?: Error, data?: string) => {
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
            resolve(Result.err(new Error("Empty response from vsock")));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(Result.ok(parsed as ExecResult));
          } catch {
            resolve(Result.err(new Error("Invalid response from vsock")));
          }
        };

        const timer = setTimeout(() => {
          socket.destroy();
          finish(new Error("Exec timeout"));
        }, timeoutMs);

        socket.setEncoding("utf8");

        socket.on("connect", () => {
          socket.end(`${JSON.stringify({ cmd, timeout: Math.floor(timeoutMs / 1000) })}\n`);
        });

        socket.on("data", (chunk: string) => {
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
            finish(new Error("Empty response from vsock"));
            return;
          }
          finish(undefined, remaining);
        });

        socket.on("error", (err: Error) => {
          finish(err);
        });
      });
    } catch (err) {
      return Result.err(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Update balloon memory
   */
  async updateBalloon(amountMib: number): Promise<Result<void, Error>> {
    return await this.client.patchBalloon({ amount_mib: amountMib });
  }

  /**
   * Get balloon statistics
   */
  async getBalloonStats(): Promise<Result<BalloonStats, Error>> {
    return await this.client.describeBalloonStats();
  }

  /**
   * Create a snapshot of the VM
   */
  async createSnapshot(params: SnapshotCreateParams): Promise<Result<void, Error>> {
    const pauseRes = await this.pause();
    if (pauseRes.isErr()) return pauseRes;
    
    return await this.client.createSnapshot(params);
  }

  /**
   * Update MMDS data
   */
  async setMetadata(data: MmdsContentsObject): Promise<Result<void, Error>> {
    return await this.client.putMmds(data);
  }

  /**
   * Patch MMDS data
   */
  async updateMetadata(data: MmdsContentsObject): Promise<Result<void, Error>> {
    return await this.client.patchMmds(data);
  }

  /**
   * Get MMDS data
   */
  async getMetadata(): Promise<Result<MmdsContentsObject, Error>> {
    return await this.client.getMmds();
  }

  /**
   * Update a drive (hot-swap)
   */
  async updateDrive(
    driveId: string,
    pathOnHost: string
  ): Promise<Result<void, Error>> {
    return await this.client.patchGuestDriveByID(driveId, {
      drive_id: driveId,
      path_on_host: pathOnHost,
    });
  }

  /**
   * Flush metrics
   */
  async flushMetrics(): Promise<Result<void, Error>> {
    return await this.client.createSyncAction("FlushMetrics");
  }

  /**
   * Wait for the VMM process to exit
   */
  async wait(): Promise<Result<number, Error>> {
    if (!this.process) {
      return Result.err(new Error("No VMM process running"));
    }
    try {
      const code = await this.process.exited;
      return Result.ok(code);
    } catch (err) {
       return Result.err(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Create and start a Machine from a snapshot
 */
export async function createMachineFromSnapshot(
  config: MachineConfig,
  snapshotParams: SnapshotLoadParams,
  ...opts: MachineOpt[]
): Promise<Result<Machine, Error>> {
  const machine = new Machine(config, ...opts);

  // Remove standard init handlers and add snapshot loading
  machine.handlers.fcInit.clear();
  machine.handlers.fcInit
    .append("StartVMM", async (m) => {
      return await m.startVMM();
    })
    .append("LoadSnapshot", async (m) => {
      return await m.client.loadSnapshot(snapshotParams);
    });

  const startRes = await machine.start();
  if (startRes.isErr()) return Result.err(startRes.error);
  
  return Result.ok(machine);
}