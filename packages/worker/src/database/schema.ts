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
 * Machines table schema
 */
export interface MachinesTable {
  id: string;
  name: string;
  status: MachineStatus;
  vcpu_count: number;
  mem_size_mib: number;
  kernel_image_path: string;
  kernel_args: string | null;
  rootfs_path: string | null;
  socket_path: string;
  tap_device: string | null;
  tap_ip: string | null;
  guest_ip: string | null;
  guest_mac: string | null;
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
 * Database schema definition for Kysely
 */
export interface Database {
  machines: MachinesTable;
}
