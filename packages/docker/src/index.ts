/**
 * @hyperfleet/docker
 *
 * A TypeScript SDK for Docker container management
 * Implements the Runtime interface from @hyperfleet/runtime
 */

// Re-export runtime types for convenience
export type { Runtime, RuntimeInfo, ExecResult, RuntimeType, RuntimeStatus } from "@hyperfleet/runtime";

// Models
export * from "./models";

// Client
export { DockerClient, DockerCliError } from "./client";
export type { DockerClientConfig, CreateContainerOptions } from "./client";

// Container
export { Container, withClient, withHandlers } from "./container";
export type { ContainerConfig, ContainerOpt } from "./container";

// Handlers
export {
  ContainerHandlerList,
  ContainerHandlers,
  createDefaultHandlers,
  ConfigValidationHandler,
  ResourceValidationHandler,
  PortValidationHandler,
  PullImageHandler,
  CreateContainerHandler,
} from "./handlers";
export type { ContainerHandler } from "./handlers";
