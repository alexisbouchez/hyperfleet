/**
 * High-level Machine abstraction for Firecracker microVMs
 * Similar to firecracker-go-sdk's Machine struct
 */

import type { Subprocess } from "bun";
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

export class Machine {
  readonly config: MachineConfig;
  client: FirecrackerClient;
  handlers: Handlers;

  private process: Subprocess | null = null;
  private started = false;
  private pid: number | null = null;

  constructor(config: MachineConfig, ...opts: MachineOpt[]) {
    this.config = config;
    this.client = new FirecrackerClient({ socketPath: config.socketPath });
    this.handlers = createDefaultHandlers();

    for (const opt of opts) {
      opt(this);
    }
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

    this.pid = this.process.pid;

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
          await this.client.describeInstance();
          return;
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
    await this.client.patchVm("Paused");
  }

  /**
   * Resume a paused microVM
   */
  async resume(): Promise<void> {
    await this.client.patchVm("Resumed");
  }

  /**
   * Send Ctrl+Alt+Del to the guest (graceful shutdown)
   */
  async sendCtrlAltDel(): Promise<void> {
    await this.client.createSyncAction("SendCtrlAltDel");
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
    return this.pid;
  }

  /**
   * Check if the machine is running
   */
  isRunning(): boolean {
    return this.started && this.process !== null;
  }

  /**
   * Get instance info
   */
  async getInstanceInfo(): Promise<InstanceInfo> {
    return this.client.describeInstance();
  }

  /**
   * Update balloon memory
   */
  async updateBalloon(amountMib: number): Promise<void> {
    await this.client.patchBalloon({ amount_mib: amountMib });
  }

  /**
   * Get balloon statistics
   */
  async getBalloonStats(): Promise<BalloonStats> {
    return this.client.describeBalloonStats();
  }

  /**
   * Create a snapshot of the VM
   */
  async createSnapshot(params: SnapshotCreateParams): Promise<void> {
    await this.pause();
    await this.client.createSnapshot(params);
  }

  /**
   * Update MMDS data
   */
  async setMetadata(data: MmdsContentsObject): Promise<void> {
    await this.client.putMmds(data);
  }

  /**
   * Patch MMDS data
   */
  async updateMetadata(data: MmdsContentsObject): Promise<void> {
    await this.client.patchMmds(data);
  }

  /**
   * Get MMDS data
   */
  async getMetadata(): Promise<MmdsContentsObject> {
    return this.client.getMmds();
  }

  /**
   * Update a drive (hot-swap)
   */
  async updateDrive(
    driveId: string,
    pathOnHost: string
  ): Promise<void> {
    await this.client.patchGuestDriveByID(driveId, {
      drive_id: driveId,
      path_on_host: pathOnHost,
    });
  }

  /**
   * Flush metrics
   */
  async flushMetrics(): Promise<void> {
    await this.client.createSyncAction("FlushMetrics");
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
      await m.client.loadSnapshot(snapshotParams);
    });

  await machine.start();
  return machine;
}
