import { Result } from "better-result";
import {
  PathTraversalError,
  ValidationError,
  NotFoundError,
} from "@hyperfleet/errors";

/**
 * Patterns that indicate path traversal attempts
 */
const PATH_TRAVERSAL_PATTERNS = [
  /\.\./,           // Parent directory traversal
  /\.\.\\/, // Windows parent directory
  /\x00/,           // Null byte injection
  /%00/,            // URL-encoded null byte
  /%2e%2e/i,        // URL-encoded ..
  /%252e%252e/i,    // Double URL-encoded ..
];

/**
 * Sanitize a file path to prevent path traversal attacks.
 *
 * @param path - The path to sanitize
 * @returns Result with the normalized path or PathTraversalError
 *
 * @example
 * ```ts
 * const result = sanitizePath("/var/lib/../etc/passwd");
 * if (result.isErr()) {
 *   console.error("Path traversal detected:", result.error.path);
 * }
 * ```
 */
export function sanitizePath(path: string): Result<string, PathTraversalError> {
  // Check for obvious traversal patterns
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(path)) {
      return Result.err(
        new PathTraversalError({
          message: "Path traversal attempt detected",
          path,
        })
      );
    }
  }

  // Ensure path is absolute (starts with /)
  if (!path.startsWith("/")) {
    return Result.err(
      new PathTraversalError({
        message: "Path must be absolute",
        path,
      })
    );
  }

  // Normalize the path and check if it still matches the original intent
  // This catches cases like /var/lib/./../../etc/passwd after normalization
  const normalized = normalizePath(path);

  // If normalized path is significantly different (lost path segments),
  // it might indicate a traversal attempt
  const originalSegments = path.split("/").filter((s) => s && s !== ".");
  const normalizedSegments = normalized.split("/").filter(Boolean);

  // Check if normalization removed parent directory references
  if (path.includes("..") && normalizedSegments.length < originalSegments.length) {
    return Result.err(
      new PathTraversalError({
        message: "Path traversal attempt detected after normalization",
        path,
      })
    );
  }

  return Result.ok(normalized);
}

/**
 * Normalize a path by resolving . and .. segments
 */
function normalizePath(path: string): string {
  const segments = path.split("/");
  const result: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      result.pop();
    } else {
      result.push(segment);
    }
  }

  return "/" + result.join("/");
}

/**
 * Check if a file exists at the given path.
 *
 * @param path - The path to check
 * @returns Result with void on success or NotFoundError
 */
export async function validateFileExists(
  path: string
): Promise<Result<void, NotFoundError>> {
  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    return Result.err(
      new NotFoundError({
        message: `File not found: ${path}`,
      })
    );
  }

  return Result.ok(undefined);
}

/**
 * Validate a kernel image path.
 * Checks for path traversal and file existence.
 *
 * @param path - The kernel image path
 * @returns Result with sanitized path or error
 */
export async function validateKernelPath(
  path: string
): Promise<Result<string, PathTraversalError | NotFoundError | ValidationError>> {
  // Check for path traversal
  const sanitizeResult = sanitizePath(path);
  if (sanitizeResult.isErr()) {
    return sanitizeResult;
  }

  const sanitizedPath = sanitizeResult.unwrap();

  // Check file exists
  const existsResult = await validateFileExists(sanitizedPath);
  if (existsResult.isErr()) {
    return Result.err(
      new ValidationError({
        message: `Kernel image not found: ${sanitizedPath}`,
      })
    );
  }

  return Result.ok(sanitizedPath);
}

/**
 * Validate a rootfs image path.
 * Checks for path traversal and file existence.
 *
 * @param path - The rootfs image path
 * @returns Result with sanitized path or error
 */
export async function validateRootfsPath(
  path: string
): Promise<Result<string, PathTraversalError | NotFoundError | ValidationError>> {
  // Check for path traversal
  const sanitizeResult = sanitizePath(path);
  if (sanitizeResult.isErr()) {
    return sanitizeResult;
  }

  const sanitizedPath = sanitizeResult.unwrap();

  // Check file exists
  const existsResult = await validateFileExists(sanitizedPath);
  if (existsResult.isErr()) {
    return Result.err(
      new ValidationError({
        message: `Rootfs image not found: ${sanitizedPath}`,
      })
    );
  }

  return Result.ok(sanitizedPath);
}

/**
 * Validate all paths in a machine creation request.
 * Returns validation errors for any invalid paths.
 *
 * @param kernelPath - Kernel image path (required for Firecracker/Cloud Hypervisor)
 * @param rootfsPath - Rootfs image path (optional)
 * @returns Result with validated paths or error
 */
export async function validateMachinePaths(
  kernelPath: string,
  rootfsPath?: string | null
): Promise<
  Result<
    { kernelPath: string; rootfsPath?: string },
    PathTraversalError | ValidationError
  >
> {
  // Validate kernel path
  const kernelResult = await validateKernelPath(kernelPath);
  if (kernelResult.isErr()) {
    return kernelResult as Result<never, PathTraversalError | ValidationError>;
  }

  // Validate rootfs path if provided
  let validatedRootfs: string | undefined;
  if (rootfsPath) {
    const rootfsResult = await validateRootfsPath(rootfsPath);
    if (rootfsResult.isErr()) {
      return rootfsResult as Result<never, PathTraversalError | ValidationError>;
    }
    validatedRootfs = rootfsResult.unwrap();
  }

  return Result.ok({
    kernelPath: kernelResult.unwrap(),
    rootfsPath: validatedRootfs,
  });
}
