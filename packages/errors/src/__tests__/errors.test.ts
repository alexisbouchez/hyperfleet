import { describe, it, expect } from "bun:test";
import {
  FirecrackerApiError,
  CloudHypervisorApiError,
  DockerCliError,
  NotFoundError,
  ValidationError,
  TimeoutError,
  VsockError,
  RuntimeError,
  PathTraversalError,
  CircuitOpenError,
  getHttpStatus,
} from "../index";

describe("Error Types", () => {
  describe("FirecrackerApiError", () => {
    it("creates error with correct properties", () => {
      const error = new FirecrackerApiError({
        message: "API failed",
        statusCode: 500,
        responseBody: '{"error": "internal"}',
      });

      expect(error.message).toBe("API failed");
      expect(error.statusCode).toBe(500);
      expect(error.responseBody).toBe('{"error": "internal"}');
      expect(error._tag).toBe("FirecrackerApiError");
    });

    it("type guard works correctly", () => {
      const error = new FirecrackerApiError({
        message: "test",
        statusCode: 400,
        responseBody: "",
      });

      expect(FirecrackerApiError.is(error)).toBe(true);
      expect(FirecrackerApiError.is(new Error("test"))).toBe(false);
      expect(FirecrackerApiError.is(null)).toBe(false);
    });
  });

  describe("CloudHypervisorApiError", () => {
    it("creates error with correct properties", () => {
      const error = new CloudHypervisorApiError({
        message: "VM failed",
        statusCode: 503,
        body: "Service unavailable",
      });

      expect(error.message).toBe("VM failed");
      expect(error.statusCode).toBe(503);
      expect(error.body).toBe("Service unavailable");
      expect(error._tag).toBe("CloudHypervisorApiError");
    });

    it("type guard works correctly", () => {
      const error = new CloudHypervisorApiError({
        message: "test",
        statusCode: 400,
      });

      expect(CloudHypervisorApiError.is(error)).toBe(true);
      expect(CloudHypervisorApiError.is(new Error("test"))).toBe(false);
    });
  });

  describe("DockerCliError", () => {
    it("creates error with correct properties", () => {
      const error = new DockerCliError({
        message: "Command failed",
        exitCode: 1,
        stderr: "Error: container not found",
      });

      expect(error.message).toBe("Command failed");
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toBe("Error: container not found");
      expect(error._tag).toBe("DockerCliError");
    });

    it("type guard works correctly", () => {
      const error = new DockerCliError({
        message: "test",
        exitCode: 0,
        stderr: "",
      });

      expect(DockerCliError.is(error)).toBe(true);
      expect(DockerCliError.is(new Error("test"))).toBe(false);
    });
  });

  describe("NotFoundError", () => {
    it("creates error with message", () => {
      const error = new NotFoundError({ message: "Resource not found" });

      expect(error.message).toBe("Resource not found");
      expect(error._tag).toBe("NotFoundError");
    });

    it("type guard works correctly", () => {
      const error = new NotFoundError({ message: "test" });

      expect(NotFoundError.is(error)).toBe(true);
      expect(NotFoundError.is(new ValidationError({ message: "test" }))).toBe(false);
    });
  });

  describe("ValidationError", () => {
    it("creates error with message", () => {
      const error = new ValidationError({ message: "Invalid input" });

      expect(error.message).toBe("Invalid input");
      expect(error._tag).toBe("ValidationError");
    });
  });

  describe("TimeoutError", () => {
    it("creates error with message", () => {
      const error = new TimeoutError({ message: "Operation timed out" });

      expect(error.message).toBe("Operation timed out");
      expect(error._tag).toBe("TimeoutError");
    });
  });

  describe("VsockError", () => {
    it("creates error with message", () => {
      const error = new VsockError({ message: "Connection failed" });

      expect(error.message).toBe("Connection failed");
      expect(error._tag).toBe("VsockError");
    });
  });

  describe("RuntimeError", () => {
    it("creates error with message and cause", () => {
      const cause = new Error("underlying error");
      const error = new RuntimeError({
        message: "Runtime failed",
        cause,
      });

      expect(error.message).toBe("Runtime failed");
      expect(error.cause).toBe(cause);
      expect(error._tag).toBe("RuntimeError");
    });
  });

  describe("PathTraversalError", () => {
    it("creates error with path", () => {
      const error = new PathTraversalError({
        message: "Path traversal detected",
        path: "../etc/passwd",
      });

      expect(error.message).toBe("Path traversal detected");
      expect(error.path).toBe("../etc/passwd");
      expect(error._tag).toBe("PathTraversalError");
    });
  });

  describe("CircuitOpenError", () => {
    it("creates error with retry info", () => {
      const error = new CircuitOpenError({
        message: "Circuit breaker open",
        retryAfterMs: 30000,
      });

      expect(error.message).toBe("Circuit breaker open");
      expect(error.retryAfterMs).toBe(30000);
      expect(error._tag).toBe("CircuitOpenError");
    });
  });
});

describe("getHttpStatus", () => {
  it("returns 404 for NotFoundError", () => {
    const error = new NotFoundError({ message: "test" });
    expect(getHttpStatus(error)).toBe(404);
  });

  it("returns 400 for ValidationError", () => {
    const error = new ValidationError({ message: "test" });
    expect(getHttpStatus(error)).toBe(400);
  });

  it("returns 400 for PathTraversalError", () => {
    const error = new PathTraversalError({ message: "test", path: "/etc" });
    expect(getHttpStatus(error)).toBe(400);
  });

  it("returns 504 for TimeoutError", () => {
    const error = new TimeoutError({ message: "test" });
    expect(getHttpStatus(error)).toBe(504);
  });

  it("returns 502 for VsockError", () => {
    const error = new VsockError({ message: "test" });
    expect(getHttpStatus(error)).toBe(502);
  });

  it("returns 503 for CircuitOpenError", () => {
    const error = new CircuitOpenError({ message: "test", retryAfterMs: 1000 });
    expect(getHttpStatus(error)).toBe(503);
  });

  it("returns 502 for FirecrackerApiError with 5xx status", () => {
    const error = new FirecrackerApiError({
      message: "test",
      statusCode: 500,
      responseBody: "",
    });
    expect(getHttpStatus(error)).toBe(502);
  });

  it("returns 400 for FirecrackerApiError with 4xx status", () => {
    const error = new FirecrackerApiError({
      message: "test",
      statusCode: 400,
      responseBody: "",
    });
    expect(getHttpStatus(error)).toBe(400);
  });

  it("returns 502 for CloudHypervisorApiError with 5xx status", () => {
    const error = new CloudHypervisorApiError({
      message: "test",
      statusCode: 503,
    });
    expect(getHttpStatus(error)).toBe(502);
  });

  it("returns 400 for CloudHypervisorApiError with 4xx status", () => {
    const error = new CloudHypervisorApiError({
      message: "test",
      statusCode: 404,
    });
    expect(getHttpStatus(error)).toBe(400);
  });

  it("returns 400 for DockerCliError with non-zero exit code", () => {
    const error = new DockerCliError({
      message: "test",
      exitCode: 1,
      stderr: "",
    });
    expect(getHttpStatus(error)).toBe(400);
  });

  it("returns 500 for RuntimeError", () => {
    const error = new RuntimeError({ message: "test" });
    expect(getHttpStatus(error)).toBe(500);
  });
});
