/**
 * Docker API client for container management
 * Uses Docker CLI for simplicity and compatibility
 */

import { Result } from "better-result";
import { DockerCliError } from "@hyperfleet/errors";
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

  private async exec(args: string[]): Promise<Result<{ stdout: string; stderr: string }, DockerCliError>> {
    return Result.tryPromise({
      try: async () => {
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
          throw new DockerCliError({
            message: `Docker command failed: ${args.join(" ")}`,
            exitCode,
            stderr,
          });
        }

        return { stdout, stderr };
      },
      catch: (cause) => {
        if (DockerCliError.is(cause)) {
          return cause;
        }
        return new DockerCliError({
          message: cause instanceof Error ? cause.message : String(cause),
          exitCode: -1,
          stderr: "",
        });
      },
    });
  }

  private async execJson<T>(args: string[]): Promise<Result<T, DockerCliError>> {
    const result = await this.exec(args);
    return result.map(({ stdout }) => JSON.parse(stdout) as T);
  }

  // Container operations

  async createContainer(options: CreateContainerOptions): Promise<Result<string, DockerCliError>> {
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

    const result = await this.exec(args);
    return result.map(({ stdout }) => stdout.trim());
  }

  async startContainer(containerId: string): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["start", containerId]);
    return result.map(() => undefined);
  }

  async stopContainer(containerId: string, timeout = 10): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["stop", "-t", timeout.toString(), containerId]);
    return result.map(() => undefined);
  }

  async killContainer(containerId: string, signal = "SIGKILL"): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["kill", "-s", signal, containerId]);
    return result.map(() => undefined);
  }

  async removeContainer(containerId: string, force = false, volumes = false): Promise<Result<void, DockerCliError>> {
    const args = ["rm"];
    if (force) args.push("-f");
    if (volumes) args.push("-v");
    args.push(containerId);
    const result = await this.exec(args);
    return result.map(() => undefined);
  }

  async pauseContainer(containerId: string): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["pause", containerId]);
    return result.map(() => undefined);
  }

  async unpauseContainer(containerId: string): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["unpause", containerId]);
    return result.map(() => undefined);
  }

  async restartContainer(containerId: string, timeout = 10): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["restart", "-t", timeout.toString(), containerId]);
    return result.map(() => undefined);
  }

  async inspectContainer(containerId: string): Promise<Result<ContainerInspect, DockerCliError>> {
    const result = await this.execJson<ContainerInspect[]>(["inspect", containerId]);
    return result.map((arr) => arr[0]);
  }

  async listContainers(all = false): Promise<Result<ContainerInfo[], DockerCliError>> {
    const args = ["ps", "--format", "{{json .}}"];
    if (all) args.push("-a");

    const result = await this.exec(args);
    return result.map(({ stdout }) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as ContainerInfo);
    });
  }

  async getContainerLogs(
    containerId: string,
    options?: { tail?: number; follow?: boolean; timestamps?: boolean }
  ): Promise<Result<string, DockerCliError>> {
    const args = ["logs"];

    if (options?.tail) {
      args.push("--tail", options.tail.toString());
    }

    if (options?.timestamps) {
      args.push("--timestamps");
    }

    args.push(containerId);

    const result = await this.exec(args);
    return result.map(({ stdout, stderr }) => stdout + stderr);
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

    const result = await this.exec(args);
    return result.match({
      ok: ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      err: (error) => ({ exitCode: error.exitCode, stdout: "", stderr: error.stderr }),
    });
  }

  async waitContainer(containerId: string): Promise<Result<number, DockerCliError>> {
    const result = await this.exec(["wait", containerId]);
    return result.map(({ stdout }) => parseInt(stdout.trim(), 10));
  }

  // Image operations

  async pullImage(image: string): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["pull", image]);
    return result.map(() => undefined);
  }

  async listImages(): Promise<Result<ImageInfo[], DockerCliError>> {
    const args = ["images", "--format", "{{json .}}"];
    const result = await this.exec(args);
    return result.map(({ stdout }) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as ImageInfo);
    });
  }

  async removeImage(image: string, force = false): Promise<Result<void, DockerCliError>> {
    const args = ["rmi"];
    if (force) args.push("-f");
    args.push(image);
    const result = await this.exec(args);
    return result.map(() => undefined);
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.exec(["image", "inspect", image]);
    return result.isOk();
  }

  // Network operations

  async createNetwork(name: string, options?: { driver?: string; subnet?: string }): Promise<Result<string, DockerCliError>> {
    const args = ["network", "create"];

    if (options?.driver) {
      args.push("--driver", options.driver);
    }

    if (options?.subnet) {
      args.push("--subnet", options.subnet);
    }

    args.push(name);

    const result = await this.exec(args);
    return result.map(({ stdout }) => stdout.trim());
  }

  async removeNetwork(name: string): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["network", "rm", name]);
    return result.map(() => undefined);
  }

  async listNetworks(): Promise<Result<NetworkInfo[], DockerCliError>> {
    const args = ["network", "ls", "--format", "{{json .}}"];
    const result = await this.exec(args);
    return result.map(({ stdout }) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as NetworkInfo);
    });
  }

  async connectNetwork(network: string, containerId: string, ip?: string): Promise<Result<void, DockerCliError>> {
    const args = ["network", "connect"];
    if (ip) {
      args.push("--ip", ip);
    }
    args.push(network, containerId);
    const result = await this.exec(args);
    return result.map(() => undefined);
  }

  async disconnectNetwork(network: string, containerId: string): Promise<Result<void, DockerCliError>> {
    const result = await this.exec(["network", "disconnect", network, containerId]);
    return result.map(() => undefined);
  }

  // Volume operations

  async createVolume(name: string): Promise<Result<string, DockerCliError>> {
    const result = await this.exec(["volume", "create", name]);
    return result.map(({ stdout }) => stdout.trim());
  }

  async removeVolume(name: string, force = false): Promise<Result<void, DockerCliError>> {
    const args = ["volume", "rm"];
    if (force) args.push("-f");
    args.push(name);
    const result = await this.exec(args);
    return result.map(() => undefined);
  }

  async listVolumes(): Promise<Result<VolumeInfo[], DockerCliError>> {
    const args = ["volume", "ls", "--format", "{{json .}}"];
    const result = await this.exec(args);
    return result.map(({ stdout }) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as VolumeInfo);
    });
  }

  // System operations

  async ping(): Promise<boolean> {
    const result = await this.exec(["info"]);
    return result.isOk();
  }

  async version(): Promise<Result<{ Client: { Version: string }; Server: { Version: string } }, DockerCliError>> {
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

// Re-export for backwards compatibility during migration
export { DockerCliError } from "@hyperfleet/errors";
