/**
 * @hyperfleet/cloud-hypervisor
 *
 * A TypeScript SDK for Cloud Hypervisor VMs
 * Implements the Runtime interface from @hyperfleet/runtime
 */

// Re-export runtime types for convenience
export type { Runtime, RuntimeInfo, ExecResult, RuntimeType, RuntimeStatus } from "@hyperfleet/runtime";

// Models
export * from "./models";

// Client
export { CloudHypervisorClient, CloudHypervisorError } from "./client";
export type { CloudHypervisorClientConfig } from "./client";

// Machine
export { Machine, withClient, withHandlers } from "./machine";
export type { MachineConfig, MachineOpt } from "./machine";

// Handlers
export {
  CloudHypervisorHandlerList,
  CloudHypervisorHandlers,
  createDefaultHandlers,
  ConfigValidationHandler,
  NetworkConfigValidationHandler,
  DiskConfigValidationHandler,
  CreateVmHandler,
  BootVmHandler,
} from "./handlers";
export type { CloudHypervisorHandler } from "./handlers";
