/**
 * Docker API client for container management
 * Uses Docker CLI for simplicity and compatibility
 */

import type {
  ContainerInfo,
  ContainerInspect,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from "./models";

export interface DockerClientConfig {
  /**
   * Docker host (defaults to unix:///var/run/docker.sock)
   */
  host?: string;

  /**
   * Docker CLI binary path (defaults to "docker")
   */
  dockerBinary?: string;
}

export class DockerError extends Error {
  constructor(
    message: string,
    public code: number,
    public stderr: string
  ) {
    super(message);
    this.name = "DockerError";
  }
}

/**
 * Docker client using CLI commands
 * This approach is simpler and more portable than the Docker Engine API
 */
export class DockerClient {
  private dockerBinary: string;
  private host?: string;

  constructor(config: DockerClientConfig = {}) {
    this.dockerBinary = config.dockerBinary || "docker";
    this.host = config.host;
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cmdArgs = [...args];

    if (this.host) {
      cmdArgs.unshift("-H", this.host);
    }

    const proc = Bun.spawn([this.dockerBinary, ...cmdArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new DockerError(
        `Docker command failed: ${args.join(" ")}`,
        exitCode,
        stderr
      );
    }

    return { stdout, stderr };
  }

  private async execJson<T>(args: string[]): Promise<T> {
    const { stdout } = await this.exec(args);
    return JSON.parse(stdout) as T;
  }

  // Container operations

  async createContainer(options: CreateContainerOptions): Promise<string> {
    const args = ["create"];

    if (options.name) {
      args.push("--name", options.name);
    }

    if (options.hostname) {
      args.push("--hostname", options.hostname);
    }

    if (options.cpus) {
      args.push("--cpus", options.cpus.toString());
    }

    if (options.memory) {
      args.push("--memory", options.memory);
    }

    if (options.memorySwap) {
      args.push("--memory-swap", options.memorySwap);
    }

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    if (options.ports) {
      for (const port of options.ports) {
        const protocol = port.protocol || "tcp";
        args.push("-p", `${port.hostPort}:${port.containerPort}/${protocol}`);
      }
    }

    if (options.volumes) {
      for (const vol of options.volumes) {
        const mode = vol.readOnly ? "ro" : "rw";
        args.push("-v", `${vol.hostPath}:${vol.containerPath}:${mode}`);
      }
    }

    if (options.network) {
      args.push("--network", options.network);
    }

    if (options.networkAliases) {
      for (const alias of options.networkAliases) {
        args.push("--network-alias", alias);
      }
    }

    if (options.workingDir) {
      args.push("-w", options.workingDir);
    }

    if (options.user) {
      args.push("-u", options.user);
    }

    if (options.privileged) {
      args.push("--privileged");
    }

    if (options.capAdd) {
      for (const cap of options.capAdd) {
        args.push("--cap-add", cap);
      }
    }

    if (options.capDrop) {
      for (const cap of options.capDrop) {
        args.push("--cap-drop", cap);
      }
    }

    if (options.restart) {
      args.push("--restart", options.restart);
    }

    if (options.labels) {
      for (const [key, value] of Object.entries(options.labels)) {
        args.push("--label", `${key}=${value}`);
      }
    }

    if (options.entrypoint) {
      args.push("--entrypoint", options.entrypoint);
    }

    args.push(options.image);

    if (options.cmd) {
      args.push(...options.cmd);
    }

    const { stdout } = await this.exec(args);
    return stdout.trim();
  }

  async startContainer(containerId: string): Promise<void> {
    await this.exec(["start", containerId]);
  }

  async stopContainer(containerId: string, timeout = 10): Promise<void> {
    await this.exec(["stop", "-t", timeout.toString(), containerId]);
  }

  async killContainer(containerId: string, signal = "SIGKILL"): Promise<void> {
    await this.exec(["kill", "-s", signal, containerId]);
  }

  async removeContainer(containerId: string, force = false, volumes = false): Promise<void> {
    const args = ["rm"];
    if (force) args.push("-f");
    if (volumes) args.push("-v");
    args.push(containerId);
    await this.exec(args);
  }

  async pauseContainer(containerId: string): Promise<void> {
    await this.exec(["pause", containerId]);
  }

  async unpauseContainer(containerId: string): Promise<void> {
    await this.exec(["unpause", containerId]);
  }

  async restartContainer(containerId: string, timeout = 10): Promise<void> {
    await this.exec(["restart", "-t", timeout.toString(), containerId]);
  }

  async inspectContainer(containerId: string): Promise<ContainerInspect> {
    const result = await this.execJson<ContainerInspect[]>(["inspect", containerId]);
    return result[0];
  }

  async listContainers(all = false): Promise<ContainerInfo[]> {
    const args = ["ps", "--format", "{{json .}}"];
    if (all) args.push("-a");

    const { stdout } = await this.exec(args);
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as ContainerInfo);
  }

  async getContainerLogs(
    containerId: string,
    options?: { tail?: number; follow?: boolean; timestamps?: boolean }
  ): Promise<string> {
    const args = ["logs"];

    if (options?.tail) {
      args.push("--tail", options.tail.toString());
    }

    if (options?.timestamps) {
      args.push("--timestamps");
    }

    args.push(containerId);

    const { stdout, stderr } = await this.exec(args);
    return stdout + stderr;
  }

  async execInContainer(
    containerId: string,
    cmd: string[],
    options?: { interactive?: boolean; tty?: boolean; user?: string; workingDir?: string }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = ["exec"];

    if (options?.interactive) {
      args.push("-i");
    }

    if (options?.tty) {
      args.push("-t");
    }

    if (options?.user) {
      args.push("-u", options.user);
    }

    if (options?.workingDir) {
      args.push("-w", options.workingDir);
    }

    args.push(containerId, ...cmd);

    try {
      const { stdout, stderr } = await this.exec(args);
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      if (error instanceof DockerError) {
        return { exitCode: error.code, stdout: "", stderr: error.stderr };
      }
      throw error;
    }
  }

  async waitContainer(containerId: string): Promise<number> {
    const { stdout } = await this.exec(["wait", containerId]);
    return parseInt(stdout.trim(), 10);
  }

  // Image operations

  async pullImage(image: string): Promise<void> {
    await this.exec(["pull", image]);
  }

  async listImages(): Promise<ImageInfo[]> {
    const args = ["images", "--format", "{{json .}}"];
    const { stdout } = await this.exec(args);
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as ImageInfo);
  }

  async removeImage(image: string, force = false): Promise<void> {
    const args = ["rmi"];
    if (force) args.push("-f");
    args.push(image);
    await this.exec(args);
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.exec(["image", "inspect", image]);
      return true;
    } catch {
      return false;
    }
  }

  // Network operations

  async createNetwork(name: string, options?: { driver?: string; subnet?: string }): Promise<string> {
    const args = ["network", "create"];

    if (options?.driver) {
      args.push("--driver", options.driver);
    }

    if (options?.subnet) {
      args.push("--subnet", options.subnet);
    }

    args.push(name);

    const { stdout } = await this.exec(args);
    return stdout.trim();
  }

  async removeNetwork(name: string): Promise<void> {
    await this.exec(["network", "rm", name]);
  }

  async listNetworks(): Promise<NetworkInfo[]> {
    const args = ["network", "ls", "--format", "{{json .}}"];
    const { stdout } = await this.exec(args);
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as NetworkInfo);
  }

  async connectNetwork(network: string, containerId: string, ip?: string): Promise<void> {
    const args = ["network", "connect"];
    if (ip) {
      args.push("--ip", ip);
    }
    args.push(network, containerId);
    await this.exec(args);
  }

  async disconnectNetwork(network: string, containerId: string): Promise<void> {
    await this.exec(["network", "disconnect", network, containerId]);
  }

  // Volume operations

  async createVolume(name: string): Promise<string> {
    const { stdout } = await this.exec(["volume", "create", name]);
    return stdout.trim();
  }

  async removeVolume(name: string, force = false): Promise<void> {
    const args = ["volume", "rm"];
    if (force) args.push("-f");
    args.push(name);
    await this.exec(args);
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const args = ["volume", "ls", "--format", "{{json .}}"];
    const { stdout } = await this.exec(args);
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as VolumeInfo);
  }

  // System operations

  async ping(): Promise<boolean> {
    try {
      await this.exec(["info"]);
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<{ Client: { Version: string }; Server: { Version: string } }> {
    return this.execJson(["version", "--format", "{{json .}}"]);
  }
}

export interface CreateContainerOptions {
  image: string;
  name?: string;
  hostname?: string;
  cpus?: number;
  memory?: string;
  memorySwap?: string;
  env?: Record<string, string>;
  ports?: Array<{ hostPort: number; containerPort: number; protocol?: "tcp" | "udp" }>;
  volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  network?: string;
  networkAliases?: string[];
  workingDir?: string;
  user?: string;
  privileged?: boolean;
  capAdd?: string[];
  capDrop?: string[];
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  labels?: Record<string, string>;
  entrypoint?: string;
  cmd?: string[];
}
