/**
 * High-level Machine abstraction for Cloud Hypervisor VMs
 * Implements the Runtime interface from @hyperfleet/runtime
 */

import type { Subprocess } from "bun";
import type { Runtime, RuntimeInfo, ExecResult } from "@hyperfleet/runtime";
import { CloudHypervisorClient } from "./client";
import type {
  VmConfig,
  VmInfo,
  DiskConfig,
  NetConfig,
  VsockConfig,
  PayloadConfig,
  CpusConfig,
  MemoryConfig,
  ConsoleConfig,
  SerialConfig,
  RngConfig,
  VmResize,
} from "./models";
import { CloudHypervisorHandlers, createDefaultHandlers } from "./handlers";

export interface MachineConfig {
  /**
   * Socket path for Cloud Hypervisor API
   */
  socketPath: string;

  /**
   * Payload configuration (kernel/firmware)
   */
  payload: PayloadConfig;

  /**
   * CPUs configuration
   */
  cpus: CpusConfig;

  /**
   * Memory configuration
   */
  memory: MemoryConfig;

  /**
   * Disk configurations
   */
  disks?: DiskConfig[];

  /**
   * Network configurations
   */
  net?: NetConfig[];

  /**
   * Vsock configuration
   */
  vsock?: VsockConfig;

  /**
   * Console configuration
   */
  console?: ConsoleConfig;

  /**
   * Serial configuration
   */
  serial?: SerialConfig;

  /**
   * RNG configuration
   */
  rng?: RngConfig;

  /**
   * Cloud Hypervisor binary path
   */
  cloudHypervisorBinary?: string;

  /**
   * Log file path
   */
  logFile?: string;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;
}

export type MachineOpt = (machine: Machine) => void;

export function withClient(client: CloudHypervisorClient): MachineOpt {
  return (machine) => {
    machine.client = client;
  };
}

export function withHandlers(handlers: CloudHypervisorHandlers): MachineOpt {
  return (machine) => {
    machine.handlers = handlers;
  };
}

export class Machine implements Runtime {
  readonly type = "cloud-hypervisor" as const;
  readonly config: MachineConfig;
  client: CloudHypervisorClient;
  handlers: CloudHypervisorHandlers;

  private process: Subprocess | null = null;
  private started = false;
  private _pid: number | null = null;

  constructor(config: MachineConfig, ...opts: MachineOpt[]) {
    this.config = config;
    this.client = new CloudHypervisorClient({ socketPath: config.socketPath });
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
    const match = this.config.socketPath.match(/cloud-hypervisor-([^.]+)\.sock/);
    return match ? match[1] : this.config.socketPath;
  }

  /**
   * Build the VM configuration object
   */
  buildVmConfig(): VmConfig {
    return {
      cpus: this.config.cpus,
      memory: this.config.memory,
      payload: this.config.payload,
      disks: this.config.disks,
      net: this.config.net,
      vsock: this.config.vsock,
      console: this.config.console,
      serial: this.config.serial,
      rng: this.config.rng,
    };
  }

  /**
   * Start the Cloud Hypervisor VMM process
   */
  async startVMM(): Promise<void> {
    const binary = this.config.cloudHypervisorBinary || "cloud-hypervisor";
    const args: string[] = ["--api-socket", this.config.socketPath];

    if (this.config.logFile) {
      args.push("--log-file", this.config.logFile);
    }

    if (this.config.verbose) {
      args.push("-v");
    }

    this.process = Bun.spawn([binary, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    });

    this._pid = this.process.pid;

    // Wait for socket to be ready
    await this.waitForSocket();
  }

  private async waitForSocket(timeoutMs = 5000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const file = Bun.file(this.config.socketPath);
        if (await file.exists()) {
          // Try to connect
          const result = await this.client.ping();
          if (result.isOk()) return;
        }
      } catch {
        // Socket not ready yet
      }
      await Bun.sleep(50);
    }

    throw new Error(`Timeout waiting for Cloud Hypervisor socket at ${this.config.socketPath}`);
  }

  /**
   * Start the VM using the handler chain
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
    await this.handlers.init.run(this);

    this.started = true;
  }

  /**
   * Pause the VM
   */
  async pause(): Promise<void> {
    (await this.client.pauseVm()).unwrap();
  }

  /**
   * Resume a paused VM
   */
  async resume(): Promise<void> {
    (await this.client.resumeVm()).unwrap();
  }

  /**
   * Stop the VM (kills the VMM process)
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      await this.process.exited;
      this.process = null;
    }
  }

  /**
   * Shutdown the VM gracefully, then force kill if needed
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.process) {
      return;
    }

    // Try graceful shutdown first (ACPI power button)
    const powerResult = await this.client.powerButton();
    if (powerResult.isErr()) {
      // Failed to send power button, force kill
      await this.stop();
      return;
    }

    // Wait for process to exit
    const exitPromise = this.process.exited;
    const timeoutPromise = Bun.sleep(timeoutMs).then(() => null);

    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (result === null) {
      // Timeout, force kill
      await this.stop();
    }
  }

  /**
   * Reboot the VM
   */
  async reboot(): Promise<void> {
    (await this.client.rebootVm()).unwrap();
  }

  /**
   * Get the PID of the Cloud Hypervisor process
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
    const result = await this.client.getVmInfo();
    return result.match({
      ok: (info) => ({
        id: this.id,
        status: this.mapVmState(info.state),
        pid: this._pid,
      }),
      err: () => ({
        id: this.id,
        status: this.process ? "running" : "stopped",
        pid: this._pid,
      }),
    });
  }

  private mapVmState(state: string): "pending" | "starting" | "running" | "paused" | "stopping" | "stopped" | "failed" {
    switch (state) {
      case "Created":
        return "pending";
      case "Running":
        return "running";
      case "Paused":
        return "paused";
      case "Shutdown":
        return "stopped";
      case "BreakPoint":
        return "paused";
      default:
        return "stopped";
    }
  }

  /**
   * Get Cloud Hypervisor VM info
   */
  async getVmInfo(): Promise<VmInfo> {
    return (await this.client.getVmInfo()).unwrap();
  }

  /**
   * Execute a command in the VM via vsock (implements Runtime interface)
   */
  async exec(cmd: string[], timeoutMs = 30000): Promise<ExecResult> {
    const { vsock } = this.config;
    if (!vsock?.socket) {
      throw new Error("Vsock not configured - cannot execute commands");
    }

    const net = await import("node:net");

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: vsock.socket });
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
   * Wait for the VMM process to exit
   */
  async wait(): Promise<number> {
    if (!this.process) {
      throw new Error("No VMM process running");
    }
    return this.process.exited;
  }

  /**
   * Resize VM resources (vCPUs, memory, balloon)
   */
  async resize(resize: VmResize): Promise<void> {
    (await this.client.resizeVm(resize)).unwrap();
  }

  /**
   * Add a disk (hot-plug)
   */
  async addDisk(disk: DiskConfig): Promise<void> {
    (await this.client.addDisk(disk)).unwrap();
  }

  /**
   * Add a network interface (hot-plug)
   */
  async addNet(net: NetConfig): Promise<void> {
    (await this.client.addNet(net)).unwrap();
  }

  /**
   * Remove a device by ID
   */
  async removeDevice(id: string): Promise<void> {
    (await this.client.removeDevice({ id })).unwrap();
  }

  /**
   * Create a snapshot
   */
  async createSnapshot(destinationUrl: string): Promise<void> {
    (await this.client.createSnapshot({ destination_url: destinationUrl })).unwrap();
  }

  /**
   * Get VM counters/metrics
   */
  async getCounters(): Promise<Record<string, Record<string, number>>> {
    return (await this.client.getVmCounters()).unwrap();
  }
}
