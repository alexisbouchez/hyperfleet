/**
 * @hyperfleet/firecracker
 *
 * A TypeScript SDK for Firecracker microVMs
 * Inspired by firecracker-go-sdk
 */

// Re-export runtime types for convenience
export type { Runtime, RuntimeInfo, ExecResult, RuntimeType, RuntimeStatus } from "@hyperfleet/runtime";

// Models
export * from "./models";

// Client
export { FirecrackerClient, FirecrackerApiError } from "./client";
export type { FirecrackerClientConfig } from "./client";

// Machine
export { Machine, createMachineFromSnapshot, withClient, withHandlers } from "./machine";
export type { MachineConfig, MachineOpt } from "./machine";

// Drives
export {
  DrivesBuilder,
  withDriveId,
  withReadOnly,
  withPartuuid,
  withCacheType,
  withIoEngine,
  withDriveRateLimiter,
} from "./drives";
export type { DriveOpt } from "./drives";

// Network
export {
  NetworkBuilder,
  withMacAddress,
  withIPConfig,
  withRxRateLimiter,
  withTxRateLimiter,
  withMmdsAccess,
  generateMacAddress,
} from "./network";
export type {
  IPConfiguration,
  StaticNetworkConfiguration,
  NetworkInterfaceConfig,
  NetworkInterfaceOpt,
} from "./network";

// Jailer
export { buildJailerArgs, getJailerChrootPath, getJailFiles } from "./jailer";
export type { JailerConfig, JailerCommandOptions, JailFile } from "./jailer";

// Handlers
export {
  HandlerList,
  Handlers,
  createDefaultHandlers,
  ConfigValidationHandler,
  NetworkConfigValidationHandler,
  CreateLogFilesHandler,
  BootstrapLoggingHandler,
  CreateMachineHandler,
  CreateBootSourceHandler,
  AttachDrivesHandler,
  CreateNetworkInterfacesHandler,
  AddVsockHandler,
  SetupBalloonHandler,
  ConfigMmdsHandler,
  StartVMMHandler,
} from "./handlers";
export type { Handler } from "./handlers";
