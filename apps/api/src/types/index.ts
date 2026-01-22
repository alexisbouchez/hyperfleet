import type { MachineStatus, RuntimeType } from "@hyperfleet/worker/database";

/**
 * Network configuration for a machine
 */
export interface NetworkConfig {
  tap_device?: string;
  tap_ip?: string;
  guest_ip?: string;
  guest_mac?: string;
}

/**
 * Port mapping for Docker containers
 */
export interface PortMapping {
  host_port: number;
  container_port: number;
  protocol?: "tcp" | "udp";
}

/**
 * Volume mount for Docker containers
 */
export interface VolumeMount {
  host_path: string;
  container_path: string;
  read_only?: boolean;
}

/**
 * Docker-specific configuration
 */
export interface DockerConfig {
  image: string;
  cmd?: string[];
  entrypoint?: string;
  env?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMount[];
  working_dir?: string;
  user?: string;
  privileged?: boolean;
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
}

/**
 * Firecracker-specific configuration
 */
export interface FirecrackerConfig {
  kernel_image_path: string;
  kernel_args?: string;
  rootfs_path?: string;
  network?: NetworkConfig;
  exposed_ports?: number[];
}

/**
 * Request body for creating a new Firecracker machine
 */
export interface CreateFirecrackerMachineBody {
  name: string;
  runtime_type: "firecracker";
  vcpu_count: number;
  mem_size_mib: number;
  kernel_image_path: string;
  kernel_args?: string;
  rootfs_path?: string;
  network?: NetworkConfig;
  exposed_ports?: number[];
}

/**
 * Request body for creating a new Docker container
 */
export interface CreateDockerMachineBody {
  name: string;
  runtime_type: "docker";
  vcpu_count?: number;
  mem_size_mib?: number;
  image: string;
  cmd?: string[];
  entrypoint?: string;
  env?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMount[];
  working_dir?: string;
  user?: string;
  privileged?: boolean;
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
}

/**
 * Request body for creating a new machine (legacy - defaults to firecracker)
 */
export interface CreateMachineBody {
  name: string;
  runtime_type?: RuntimeType;
  vcpu_count: number;
  mem_size_mib: number;
  // Firecracker fields
  kernel_image_path: string;
  kernel_args?: string;
  rootfs_path?: string;
  network?: NetworkConfig;
  exposed_ports?: number[];
  // Docker fields
  image?: string;
  cmd?: string[];
  entrypoint?: string;
  env?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMount[];
  working_dir?: string;
  user?: string;
  privileged?: boolean;
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
}

/**
 * Query params for listing machines
 */
export interface ListMachinesQuery {
  status?: MachineStatus;
  runtime_type?: RuntimeType;
}

/**
 * Machine response object
 */
export interface MachineResponse {
  id: string;
  name: string;
  status: MachineStatus;
  runtime_type: RuntimeType;
  vcpu_count: number;
  mem_size_mib: number;
  // Firecracker-specific
  kernel_image_path: string;
  kernel_args: string | null;
  rootfs_path: string | null;
  network: NetworkConfig | null;
  exposed_ports?: number[];
  // Docker-specific
  image: string | null;
  container_id: string | null;
  // Common
  pid: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Error response
 */
export interface ErrorResponse {
  error: string;
  message: string;
}

/**
 * Request body for executing a command
 */
export interface ExecBody {
  cmd: string[];
  timeout?: number;
}

/**
 * Response from executing a command
 */
export interface ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}
