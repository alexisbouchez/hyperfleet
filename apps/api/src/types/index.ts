import type { MachineStatus } from "@hyperfleet/worker/database";

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
 * Request body for creating a new machine
 */
export interface CreateMachineBody {
  name: string;
  vcpu_count: number;
  mem_size_mib: number;
  kernel_image_path: string;
  kernel_args?: string;
  rootfs_path?: string;
  network?: NetworkConfig;
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
  vcpu_count: number;
  mem_size_mib: number;
  kernel_image_path: string;
  kernel_args: string | null;
  rootfs_path: string | null;
  network: NetworkConfig | null;
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
