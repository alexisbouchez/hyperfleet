/**
 * High-level Machine abstraction for Firecracker microVMs
 * Similar to firecracker-go-sdk's Machine struct
 */

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
  async startVMM(): Promise<void> {
    const args: string[] = [];

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

    this._pid = this.process.pid;

    // Wait for socket to be ready
    await this.waitForSocket();
  }

  private async waitForSocket(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    const socketPath = this.config.jailer
      ? `${getJailerChrootPath(this.config.jailer)}/${this.config.socketPath}`
      : this.config.socketPath;

    while (Date.now() - start < timeoutMs) {
      try {
        const file = Bun.file(socketPath);
        if (await file.exists()) {
          // Try to connect
          const result = await this.client.describeInstance();
          if (result.isOk()) return;
        }
      } catch {
        // Socket not ready yet
      }
      await Bun.sleep(50);
    }

    throw new Error(`Timeout waiting for Firecracker socket at ${socketPath}`);
  }

  /**
   * Start the microVM using the handler chain
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Machine already started");
    }

    // Run validation handlers
    await this.handlers.validation.run(this);

    // Start VMM process if not using external process
    if (!this.process) {
      await this.startVMM();
    }

    // Run initialization handlers
    await this.handlers.fcInit.run(this);

    this.started = true;
  }

  /**
   * Pause the microVM
   */
  async pause(): Promise<void> {
    (await this.client.patchVm("Paused")).unwrap();
  }

  /**
   * Resume a paused microVM
   */
  async resume(): Promise<void> {
    (await this.client.patchVm("Resumed")).unwrap();
  }

  /**
   * Send Ctrl+Alt+Del to the guest (graceful shutdown)
   */
  async sendCtrlAltDel(): Promise<void> {
    (await this.client.createSyncAction("SendCtrlAltDel")).unwrap();
  }

  /**
   * Stop the microVM
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      await this.process.exited;
      this.process = null;
    }
  }

  /**
   * Shutdown the microVM gracefully, then force kill if needed
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      // Try graceful shutdown first
      await this.sendCtrlAltDel();

      // Wait for process to exit
      const exitPromise = this.process.exited;
      const timeoutPromise = Bun.sleep(timeoutMs).then(() => null);

      const result = await Promise.race([exitPromise, timeoutPromise]);

      if (result === null) {
        // Timeout, force kill
        await this.stop();
      }
    } catch {
      // Failed to send ctrl+alt+del, force kill
      await this.stop();
    }
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
  async getInfo(): Promise<RuntimeInfo> {
    const info = await this.getInstanceInfo();
    return {
      id: this.id,
      status: info.state === "Running" ? "running" : info.state === "Paused" ? "paused" : "stopped",
      pid: this._pid,
    };
  }

  /**
   * Get Firecracker instance info
   */
  async getInstanceInfo(): Promise<InstanceInfo> {
    return (await this.client.describeInstance()).unwrap();
  }

  /**
   * Execute a command in the VM via vsock (implements Runtime interface)
   */
  async exec(cmd: string[], timeoutMs = 30000): Promise<ExecResult> {
    const { vsock } = this.config;
    if (!vsock?.uds_path) {
      throw new Error("Vsock not configured - cannot execute commands");
    }

    // Dynamic import to avoid top-level import issues
    const net = await import("node:net");

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: vsock.uds_path });
      let settled = false;
      let buffer = "";

      const finish = (err?: Error, data?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        if (err) {
          reject(err);
          return;
        }
        if (!data) {
          reject(new Error("Empty response from vsock"));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed as ExecResult);
        } catch {
          reject(new Error("Invalid response from vsock"));
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
  }

  /**
   * Update balloon memory
   */
  async updateBalloon(amountMib: number): Promise<void> {
    (await this.client.patchBalloon({ amount_mib: amountMib })).unwrap();
  }

  /**
   * Get balloon statistics
   */
  async getBalloonStats(): Promise<BalloonStats> {
    return (await this.client.describeBalloonStats()).unwrap();
  }

  /**
   * Create a snapshot of the VM
   */
  async createSnapshot(params: SnapshotCreateParams): Promise<void> {
    await this.pause();
    (await this.client.createSnapshot(params)).unwrap();
  }

  /**
   * Update MMDS data
   */
  async setMetadata(data: MmdsContentsObject): Promise<void> {
    (await this.client.putMmds(data)).unwrap();
  }

  /**
   * Patch MMDS data
   */
  async updateMetadata(data: MmdsContentsObject): Promise<void> {
    (await this.client.patchMmds(data)).unwrap();
  }

  /**
   * Get MMDS data
   */
  async getMetadata(): Promise<MmdsContentsObject> {
    return (await this.client.getMmds()).unwrap();
  }

  /**
   * Update a drive (hot-swap)
   */
  async updateDrive(
    driveId: string,
    pathOnHost: string
  ): Promise<void> {
    (await this.client.patchGuestDriveByID(driveId, {
      drive_id: driveId,
      path_on_host: pathOnHost,
    })).unwrap();
  }

  /**
   * Flush metrics
   */
  async flushMetrics(): Promise<void> {
    (await this.client.createSyncAction("FlushMetrics")).unwrap();
  }

  /**
   * Wait for the VMM process to exit
   */
  async wait(): Promise<number> {
    if (!this.process) {
      throw new Error("No VMM process running");
    }
    return this.process.exited;
  }
}

/**
 * Create and start a Machine from a snapshot
 */
export async function createMachineFromSnapshot(
  config: MachineConfig,
  snapshotParams: SnapshotLoadParams,
  ...opts: MachineOpt[]
): Promise<Machine> {
  const machine = new Machine(config, ...opts);

  // Remove standard init handlers and add snapshot loading
  machine.handlers.fcInit.clear();
  machine.handlers.fcInit
    .append("StartVMM", async (m) => {
      await m.startVMM();
    })
    .append("LoadSnapshot", async (m) => {
      (await m.client.loadSnapshot(snapshotParams)).unwrap();
    });

  await machine.start();
  return machine;
}
