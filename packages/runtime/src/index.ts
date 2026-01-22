/**
 * @hyperfleet/runtime
 *
 * Shared runtime interface for container/VM management
 * Supports multiple backends: Firecracker microVMs, Docker containers
 */

/**
 * Runtime type discriminator
 */
export type RuntimeType = "firecracker" | "docker" | "cloud-hypervisor";

/**
 * Common status for all runtime types
 */
export type RuntimeStatus =
  | "pending"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * Result of command execution
 */
export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runtime instance information
 */
export interface RuntimeInfo {
  id: string;
  status: RuntimeStatus;
  pid?: number | null;
  startedAt?: string;
}

/**
 * Network configuration common to all runtimes
 */
export interface NetworkConfig {
  hostInterface?: string;
  hostIp?: string;
  guestIp?: string;
  guestMac?: string;
  ports?: PortMapping[];
}

/**
 * Port mapping for container networking
 */
export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol?: "tcp" | "udp";
}

/**
 * Volume mount configuration
 */
export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/**
 * Environment variable configuration
 */
export interface EnvVar {
  name: string;
  value: string;
}

/**
 * Base configuration for all runtimes
 */
export interface BaseRuntimeConfig {
  /**
   * Unique identifier for the runtime instance
   */
  id: string;

  /**
   * Human-readable name
   */
  name?: string;

  /**
   * Number of CPUs allocated
   */
  cpus: number;

  /**
   * Memory size in MiB
   */
  memoryMib: number;

  /**
   * Network configuration
   */
  network?: NetworkConfig;

  /**
   * Volume mounts
   */
  volumes?: VolumeMount[];

  /**
   * Environment variables
   */
  env?: EnvVar[];

  /**
   * Working directory
   */
  workingDir?: string;
}

/**
 * Core runtime interface that all backends must implement
 */
export interface Runtime {
  /**
   * The type of runtime (firecracker, docker, etc.)
   */
  readonly type: RuntimeType;

  /**
   * The unique identifier for this runtime instance
   */
  readonly id: string;

  /**
   * Start the runtime instance
   */
  start(): Promise<void>;

  /**
   * Stop the runtime instance
   */
  stop(): Promise<void>;

  /**
   * Pause the runtime instance (if supported)
   */
  pause(): Promise<void>;

  /**
   * Resume a paused runtime instance
   */
  resume(): Promise<void>;

  /**
   * Graceful shutdown with timeout, then force kill
   */
  shutdown(timeoutMs?: number): Promise<void>;

  /**
   * Check if the runtime is currently running
   */
  isRunning(): boolean;

  /**
   * Get the process ID (or container ID for Docker)
   */
  getPid(): number | string | null;

  /**
   * Get runtime instance information
   */
  getInfo(): Promise<RuntimeInfo>;

  /**
   * Execute a command in the runtime
   */
  exec(cmd: string[], timeoutMs?: number): Promise<ExecResult>;

  /**
   * Wait for the runtime to exit
   */
  wait(): Promise<number>;
}

/**
 * Handler function type for runtime lifecycle
 */
export type RuntimeHandler<T extends Runtime = Runtime> = (runtime: T) => Promise<void>;

/**
 * Handler list for managing ordered handler chains
 */
export class HandlerList<T extends Runtime = Runtime> {
  private handlers: Map<string, RuntimeHandler<T>> = new Map();
  private order: string[] = [];

  append(name: string, handler: RuntimeHandler<T>): this {
    if (!this.handlers.has(name)) {
      this.order.push(name);
    }
    this.handlers.set(name, handler);
    return this;
  }

  prepend(name: string, handler: RuntimeHandler<T>): this {
    if (this.handlers.has(name)) {
      this.order = this.order.filter((n) => n !== name);
    }
    this.handlers.set(name, handler);
    this.order.unshift(name);
    return this;
  }

  remove(name: string): this {
    this.handlers.delete(name);
    this.order = this.order.filter((n) => n !== name);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  clear(): this {
    this.handlers.clear();
    this.order = [];
    return this;
  }

  async run(runtime: T): Promise<void> {
    for (const name of this.order) {
      const handler = this.handlers.get(name);
      if (handler) {
        await handler(runtime);
      }
    }
  }

  list(): string[] {
    return [...this.order];
  }
}

/**
 * Factory interface for creating runtime instances
 */
export interface RuntimeFactory<TConfig, TRuntime extends Runtime> {
  /**
   * Create a new runtime instance from configuration
   */
  create(config: TConfig): TRuntime;
}
