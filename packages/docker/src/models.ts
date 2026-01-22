/**
 * Docker API models and types
 */

/**
 * Container status from docker ps
 */
export type ContainerStatus =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead";

/**
 * Container info from docker ps
 */
export interface ContainerInfo {
  ID: string;
  Names: string;
  Image: string;
  Command: string;
  CreatedAt: string;
  Status: string;
  Ports: string;
  State: ContainerStatus;
  Size?: string;
  Labels?: string;
  Mounts?: string;
  Networks?: string;
}

/**
 * Container inspect result
 */
export interface ContainerInspect {
  Id: string;
  Created: string;
  Path: string;
  Args: string[];
  State: {
    Status: ContainerStatus;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    Dead: boolean;
    Pid: number;
    ExitCode: number;
    Error: string;
    StartedAt: string;
    FinishedAt: string;
  };
  Image: string;
  Name: string;
  RestartCount: number;
  Platform: string;
  HostConfig: {
    CpuShares: number;
    Memory: number;
    MemorySwap: number;
    CpuPeriod: number;
    CpuQuota: number;
    NanoCpus: number;
    PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    Binds?: string[];
    NetworkMode: string;
    RestartPolicy: {
      Name: string;
      MaximumRetryCount: number;
    };
    Privileged: boolean;
    CapAdd?: string[];
    CapDrop?: string[];
  };
  Config: {
    Hostname: string;
    User: string;
    Env?: string[];
    Cmd?: string[];
    Entrypoint?: string[];
    Image: string;
    WorkingDir: string;
    Labels?: Record<string, string>;
  };
  NetworkSettings: {
    Bridge: string;
    Gateway: string;
    IPAddress: string;
    IPPrefixLen: number;
    MacAddress: string;
    Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
    Networks?: Record<string, {
      IPAMConfig?: { IPv4Address?: string };
      Gateway: string;
      IPAddress: string;
      IPPrefixLen: number;
      MacAddress: string;
      NetworkID: string;
    }>;
  };
}

/**
 * Image info from docker images
 */
export interface ImageInfo {
  ID: string;
  Repository: string;
  Tag: string;
  CreatedAt: string;
  CreatedSince: string;
  Size: string;
  Containers: string;
}

/**
 * Network info from docker network ls
 */
export interface NetworkInfo {
  ID: string;
  Name: string;
  Driver: string;
  Scope: string;
  IPv6: string;
  Internal: string;
  Labels?: string;
  CreatedAt?: string;
}

/**
 * Volume info from docker volume ls
 */
export interface VolumeInfo {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Scope: string;
  Labels?: string;
}
