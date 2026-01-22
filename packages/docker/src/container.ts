/**
 * High-level Container abstraction for Docker containers
 * Implements the Runtime interface from @hyperfleet/runtime
 */

import type { Runtime, RuntimeInfo, ExecResult, RuntimeStatus } from "@hyperfleet/runtime";
import { DockerClient, type CreateContainerOptions } from "./client";
import type { ContainerStatus } from "./models";
import { ContainerHandlers, createDefaultHandlers } from "./handlers";

export interface ContainerConfig {
  /**
   * Unique identifier for the container
   */
  id: string;

  /**
   * Container name (defaults to hyperfleet-{id})
   */
  name?: string;

  /**
   * Docker image to use
   */
  image: string;

  /**
   * Command to run in the container
   */
  cmd?: string[];

  /**
   * Entrypoint override
   */
  entrypoint?: string;

  /**
   * Number of CPUs allocated
   */
  cpus?: number;

  /**
   * Memory size in MiB
   */
  memoryMib?: number;

  /**
   * Environment variables
   */
  env?: Record<string, string>;

  /**
   * Port mappings (host:container)
   */
  ports?: Array<{
    hostPort: number;
    containerPort: number;
    protocol?: "tcp" | "udp";
  }>;

  /**
   * Volume mounts
   */
  volumes?: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;

  /**
   * Network name to connect to
   */
  network?: string;

  /**
   * Working directory inside the container
   */
  workingDir?: string;

  /**
   * User to run as
   */
  user?: string;

  /**
   * Run in privileged mode
   */
  privileged?: boolean;

  /**
   * Capabilities to add
   */
  capAdd?: string[];

  /**
   * Capabilities to drop
   */
  capDrop?: string[];

  /**
   * Restart policy
   */
  restart?: "no" | "always" | "on-failure" | "unless-stopped";

  /**
   * Labels to apply to the container
   */
  labels?: Record<string, string>;

  /**
   * Docker host (defaults to local socket)
   */
  dockerHost?: string;

  /**
   * Docker CLI binary path
   */
  dockerBinary?: string;
}

export type ContainerOpt = (container: Container) => void;

export function withClient(client: DockerClient): ContainerOpt {
  return (container) => {
    container.client = client;
  };
}

export function withHandlers(handlers: ContainerHandlers): ContainerOpt {
  return (container) => {
    container.handlers = handlers;
  };
}

/**
 * Map Docker container status to runtime status
 */
function mapContainerStatus(status: ContainerStatus): RuntimeStatus {
  switch (status) {
    case "created":
      return "pending";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "restarting":
      return "starting";
    case "removing":
    case "exited":
    case "dead":
      return "stopped";
    default:
      return "stopped";
  }
}

export class Container implements Runtime {
  readonly type = "docker" as const;
  readonly config: ContainerConfig;
  client: DockerClient;
  handlers: ContainerHandlers;

  private containerId: string | null = null;
  private started = false;

  constructor(config: ContainerConfig, ...opts: ContainerOpt[]) {
    this.config = config;
    this.client = new DockerClient({
      host: config.dockerHost,
      dockerBinary: config.dockerBinary,
    });
    this.handlers = createDefaultHandlers();

    for (const opt of opts) {
      opt(this);
    }
  }

  /**
   * Get the unique identifier for this container
   */
  get id(): string {
    return this.config.id;
  }

  /**
   * Get the container name
   */
  get name(): string {
    return this.config.name || `hyperfleet-${this.config.id}`;
  }

  /**
   * Get the Docker container ID (after creation)
   */
  getContainerId(): string | null {
    return this.containerId;
  }

  /**
   * Create the container (does not start it)
   */
  async create(): Promise<void> {
    // Pull image if needed
    const imageExists = await this.client.imageExists(this.config.image);
    if (!imageExists) {
      (await this.client.pullImage(this.config.image)).unwrap();
    }

    const options: CreateContainerOptions = {
      image: this.config.image,
      name: this.name,
      cmd: this.config.cmd,
      entrypoint: this.config.entrypoint,
      cpus: this.config.cpus,
      memory: this.config.memoryMib ? `${this.config.memoryMib}m` : undefined,
      env: this.config.env,
      ports: this.config.ports,
      volumes: this.config.volumes,
      network: this.config.network,
      workingDir: this.config.workingDir,
      user: this.config.user,
      privileged: this.config.privileged,
      capAdd: this.config.capAdd,
      capDrop: this.config.capDrop,
      restart: this.config.restart,
      labels: {
        ...this.config.labels,
        "hyperfleet.id": this.config.id,
        "hyperfleet.managed": "true",
      },
    };

    this.containerId = (await this.client.createContainer(options)).unwrap();
  }

  /**
   * Start the container using the handler chain
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Container already started");
    }

    // Run validation handlers
    await this.handlers.validation.run(this);

    // Create the container if not already created
    if (!this.containerId) {
      await this.handlers.init.run(this);
    }

    // Start the container
    if (this.containerId) {
      (await this.client.startContainer(this.containerId)).unwrap();
    }

    this.started = true;
  }

  /**
   * Stop the container
   */
  async stop(): Promise<void> {
    if (!this.containerId) {
      return;
    }

    // Use short timeout (2s) for graceful stop, then force kill
    const result = await this.client.stopContainer(this.containerId, 2);
    // Ignore errors - container might already be stopped
    result.unwrapOr(undefined);
    this.started = false;
  }

  /**
   * Pause the container
   */
  async pause(): Promise<void> {
    if (!this.containerId) {
      throw new Error("Container not created");
    }

    (await this.client.pauseContainer(this.containerId)).unwrap();
  }

  /**
   * Resume a paused container
   */
  async resume(): Promise<void> {
    if (!this.containerId) {
      throw new Error("Container not created");
    }

    (await this.client.unpauseContainer(this.containerId)).unwrap();
  }

  /**
   * Graceful shutdown with timeout, then force kill
   */
  async shutdown(timeoutMs = 10000): Promise<void> {
    if (!this.containerId) {
      return;
    }

    const timeoutSeconds = Math.ceil(timeoutMs / 1000);

    const stopResult = await this.client.stopContainer(this.containerId, timeoutSeconds);
    if (stopResult.isErr()) {
      // Force kill if stop fails
      const killResult = await this.client.killContainer(this.containerId);
      // Ignore errors - already stopped
      killResult.unwrapOr(undefined);
    }
    this.started = false;
  }

  /**
   * Check if the container is running
   */
  isRunning(): boolean {
    return this.started && this.containerId !== null;
  }

  /**
   * Get the container PID (from Docker inspect)
   */
  getPid(): number | string | null {
    return this.containerId;
  }

  /**
   * Get runtime information
   */
  async getInfo(): Promise<RuntimeInfo> {
    if (!this.containerId) {
      return {
        id: this.id,
        status: "pending",
      };
    }

    const result = await this.client.inspectContainer(this.containerId);
    return result.match({
      ok: (inspect) => ({
        id: this.id,
        status: mapContainerStatus(inspect.State.Status),
        pid: inspect.State.Pid || null,
        startedAt: inspect.State.StartedAt,
      }),
      err: () => ({
        id: this.id,
        status: "stopped" as RuntimeStatus,
      }),
    });
  }

  /**
   * Execute a command in the container
   */
  async exec(cmd: string[], timeoutMs = 30000): Promise<ExecResult> {
    if (!this.containerId) {
      throw new Error("Container not created");
    }

    // Docker exec doesn't have a native timeout, so we implement one
    const execPromise = this.client.execInContainer(this.containerId, cmd);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Exec timeout")), timeoutMs);
    });

    const result = await Promise.race([execPromise, timeoutPromise]);

    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Wait for the container to exit
   */
  async wait(): Promise<number> {
    if (!this.containerId) {
      throw new Error("Container not created");
    }

    return (await this.client.waitContainer(this.containerId)).unwrap();
  }

  /**
   * Remove the container
   */
  async remove(force = false, volumes = false): Promise<void> {
    if (!this.containerId) {
      return;
    }

    (await this.client.removeContainer(this.containerId, force, volumes)).unwrap();
    this.containerId = null;
    this.started = false;
  }

  /**
   * Get container logs
   */
  async logs(options?: { tail?: number; timestamps?: boolean }): Promise<string> {
    if (!this.containerId) {
      throw new Error("Container not created");
    }

    return (await this.client.getContainerLogs(this.containerId, options)).unwrap();
  }

  /**
   * Restart the container
   */
  async restart(timeoutSeconds = 10): Promise<void> {
    if (!this.containerId) {
      throw new Error("Container not created");
    }

    (await this.client.restartContainer(this.containerId, timeoutSeconds)).unwrap();
  }
}
