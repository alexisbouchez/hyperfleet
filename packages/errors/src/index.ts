/* eslint-disable no-redeclare */
import { TaggedError } from "better-result";

// Firecracker API errors
export const FirecrackerApiError = TaggedError("FirecrackerApiError")<{
  message: string;
  statusCode: number;
  responseBody: string;
}>();

export type FirecrackerApiError = InstanceType<typeof FirecrackerApiError>;

// Cloud Hypervisor API errors
export const CloudHypervisorApiError = TaggedError("CloudHypervisorApiError")<{
  message: string;
  statusCode: number;
  body?: string;
}>();

export type CloudHypervisorApiError = InstanceType<typeof CloudHypervisorApiError>;

// Docker CLI errors
export const DockerCliError = TaggedError("DockerCliError")<{
  message: string;
  exitCode: number;
  stderr: string;
}>();

export type DockerCliError = InstanceType<typeof DockerCliError>;

// Not found errors
export const NotFoundError = TaggedError("NotFoundError")<{
  message: string;
}>();

export type NotFoundError = InstanceType<typeof NotFoundError>;

// Validation errors
export const ValidationError = TaggedError("ValidationError")<{
  message: string;
}>();

export type ValidationError = InstanceType<typeof ValidationError>;

// Timeout errors
export const TimeoutError = TaggedError("TimeoutError")<{
  message: string;
}>();

export type TimeoutError = InstanceType<typeof TimeoutError>;

// Vsock communication errors
export const VsockError = TaggedError("VsockError")<{
  message: string;
}>();

export type VsockError = InstanceType<typeof VsockError>;

// Runtime errors (generic)
export const RuntimeError = TaggedError("RuntimeError")<{
  message: string;
  cause?: unknown;
}>();

export type RuntimeError = InstanceType<typeof RuntimeError>;

// Path traversal errors (security)
export const PathTraversalError = TaggedError("PathTraversalError")<{
  message: string;
  path: string;
}>();

export type PathTraversalError = InstanceType<typeof PathTraversalError>;

// Circuit breaker errors
export const CircuitOpenError = TaggedError("CircuitOpenError")<{
  message: string;
  retryAfterMs: number;
}>();

export type CircuitOpenError = InstanceType<typeof CircuitOpenError>;

// Union type for all Hyperfleet errors
export type HyperfleetError =
  | FirecrackerApiError
  | CloudHypervisorApiError
  | DockerCliError
  | NotFoundError
  | ValidationError
  | TimeoutError
  | VsockError
  | RuntimeError
  | PathTraversalError
  | CircuitOpenError;

/**
 * Get HTTP status code for an error
 */
export function getHttpStatus(error: HyperfleetError): number {
  switch (error._tag) {
    case "NotFoundError":
      return 404;
    case "ValidationError":
      return 400;
    case "PathTraversalError":
      return 400;
    case "TimeoutError":
      return 504;
    case "VsockError":
      return 502;
    case "CircuitOpenError":
      return 503;
    case "FirecrackerApiError":
      return error.statusCode >= 500 ? 502 : 400;
    case "CloudHypervisorApiError":
      return error.statusCode >= 500 ? 502 : 400;
    case "DockerCliError":
      return error.exitCode === 0 ? 500 : 400;
    case "RuntimeError":
    default:
      return 500;
  }
}
