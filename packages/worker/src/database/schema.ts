import type { Generated, Insertable, Selectable, Updateable } from "kysely";

/**
 * Machine status enum
 */
export type MachineStatus =
  | "pending"
  | "starting"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * Runtime type enum
 */
export type RuntimeType = "firecracker";

/**
 * Machines table schema
 */
export interface MachinesTable {
  id: string;
  name: string;
  status: MachineStatus;
  runtime_type: RuntimeType;
  vcpu_count: number;
  mem_size_mib: number;
  // Firecracker-specific fields
  kernel_image_path: string;
  kernel_args: string | null;
  rootfs_path: string | null;
  socket_path: string;
  tap_device: string | null;
  tap_ip: string | null;
  guest_ip: string | null;
  guest_mac: string | null;
  // Common fields
  pid: number | null;
  config_json: string;
  error_message: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/**
 * Type for SELECT queries
 */
export type Machine = Selectable<MachinesTable>;

/**
 * Type for INSERT queries
 */
export type NewMachine = Insertable<MachinesTable>;

/**
 * Type for UPDATE queries
 */
export type MachineUpdate = Updateable<MachinesTable>;

/**
 * API Keys table schema
 */
export interface ApiKeysTable {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: Generated<string>;
  revoked_at: string | null;
}

/**
 * Type for SELECT queries on api_keys
 */
export type ApiKey = Selectable<ApiKeysTable>;

/**
 * Type for INSERT queries on api_keys
 */
export type NewApiKey = Insertable<ApiKeysTable>;

/**
 * Database schema definition for Kysely
 */
export interface Database {
  machines: MachinesTable;
  api_keys: ApiKeysTable;
}
