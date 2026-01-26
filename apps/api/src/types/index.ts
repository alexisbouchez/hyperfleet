import type { MachineStatus } from "@hyperfleet/worker/database";

/**
 * Network configuration for a machine
 */
export interface NetworkConfig {
  /** Enable automatic network allocation */
  enable?: boolean;
  tap_device?: string;
  tap_ip?: string;
  guest_ip?: string;
  guest_mac?: string;
}

/**
 * Registry authentication for private OCI images
 */
export interface RegistryAuth {
  username: string;
  password: string;
}

/**
 * Request body for creating a new Firecracker machine
 */
export interface CreateMachineBody {
  name: string;
  vcpu_count: number;
  mem_size_mib: number;

  /** OCI image reference (e.g., "alpine:latest") */
  image?: string;
  /** Size of the generated rootfs in MiB (default: 1024) */
  image_size_mib?: number;
  /** Registry authentication for private images */
  registry_auth?: RegistryAuth;

  network?: NetworkConfig;
  exposed_ports?: number[];
}

/**
 * Query params for listing machines
 */
export interface ListMachinesQuery {
  status?: MachineStatus;
}

/**
 * Machine response object
 */
export interface MachineResponse {
  id: string;
  name: string;
  status: MachineStatus;
  runtime_type: "firecracker";
  vcpu_count: number;
  mem_size_mib: number;
  kernel_image_path: string;
  kernel_args: string | null;
  rootfs_path: string | null;
  /** OCI image reference if booted from image */
  image_ref: string | null;
  /** OCI image digest for cache validation */
  image_digest: string | null;
  network: NetworkConfig | null;
  exposed_ports?: number[];
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
