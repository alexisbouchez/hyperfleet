import { Result } from "better-result";

/**
 * @hyperfleet/runtime
 *
 * Shared runtime interface for Firecracker microVM management
 */

/**
 * Runtime type discriminator
 */
export type RuntimeType = "firecracker";

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
   * The type of runtime
   */
  readonly type: RuntimeType;

  /**
   * The unique identifier for this runtime instance
   */
  readonly id: string;

  /**
   * Start the runtime instance
   */
  start(): Promise<Result<void, Error>>;

  /**
   * Stop the runtime instance
   */
  stop(): Promise<Result<void, Error>>;

  /**
   * Pause the runtime instance (if supported)
   */
  pause(): Promise<Result<void, Error>>;

  /**
   * Resume a paused runtime instance
   */
  resume(): Promise<Result<void, Error>>;

  /**
   * Graceful shutdown with timeout, then force kill
   */
  shutdown(timeoutMs?: number): Promise<Result<void, Error>>;

  /**
   * Restart the runtime instance
   */
  restart(timeoutSeconds?: number): Promise<Result<void, Error>>;

  /**
   * Check if the runtime is currently running
   */
  isRunning(): boolean;

  /**
   * Get the process ID
   */
  getPid(): number | null;

  /**
   * Get runtime instance information
   */
  getInfo(): Promise<Result<RuntimeInfo, Error>>;

  /**
   * Execute a command in the runtime
   */
  exec(cmd: string[], timeoutMs?: number): Promise<Result<ExecResult, Error>>;

  /**
   * Wait for the runtime to exit
   */
  wait(): Promise<Result<number, Error>>;
}

/**
 * Handler function type for runtime lifecycle
 */
export type RuntimeHandler<T extends Runtime = Runtime> = (runtime: T) => Promise<Result<void, Error>>;

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

  async run(runtime: T): Promise<Result<void, Error>> {
    for (const name of this.order) {
      const handler = this.handlers.get(name);
      if (handler) {
        const result = await handler(runtime);
        if (result.isErr()) {
          return result;
        }
      }
    }
    return Result.ok(undefined);
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
