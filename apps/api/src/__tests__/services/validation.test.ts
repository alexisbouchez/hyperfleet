import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  sanitizePath,
  validateFileExists,
  validateKernelPath,
  validateRootfsPath,
  validateMachinePaths,
} from "../../services/validation";
import { PathTraversalError, NotFoundError, ValidationError } from "@hyperfleet/errors";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Path Validation", () => {
  describe("sanitizePath", () => {
    it("accepts valid absolute paths", () => {
      const result = sanitizePath("/var/lib/hyperfleet/kernel.img");
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe("/var/lib/hyperfleet/kernel.img");
    });

    it("normalizes paths with . segments", () => {
      const result = sanitizePath("/var/./lib/./hyperfleet/kernel.img");
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe("/var/lib/hyperfleet/kernel.img");
    });

    it("rejects paths with .. traversal", () => {
      const result = sanitizePath("/var/lib/../etc/passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
      expect(result.error.path).toBe("/var/lib/../etc/passwd");
    });

    it("rejects paths with backslash traversal", () => {
      const result = sanitizePath("/var/lib/..\\etc\\passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("rejects paths with null bytes", () => {
      const result = sanitizePath("/var/lib/hyperfleet\x00/kernel");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("rejects paths with URL-encoded null bytes", () => {
      const result = sanitizePath("/var/lib/hyperfleet%00/kernel");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("rejects paths with URL-encoded traversal", () => {
      const result = sanitizePath("/var/lib/%2e%2e/etc/passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("rejects paths with double URL-encoded traversal", () => {
      const result = sanitizePath("/var/lib/%252e%252e/etc/passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("rejects relative paths", () => {
      const result = sanitizePath("kernel.img");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("absolute");
    });

    it("rejects paths starting with . but not /", () => {
      const result = sanitizePath("./kernel.img");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("accepts paths with colons (valid on Unix)", () => {
      const result = sanitizePath("/var/lib/file:with:colons");
      expect(result.isOk()).toBe(true);
    });

    it("accepts paths with spaces", () => {
      const result = sanitizePath("/var/lib/path with spaces/kernel.img");
      expect(result.isOk()).toBe(true);
    });

    it("accepts root path", () => {
      const result = sanitizePath("/");
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe("/");
    });
  });

  describe("validateFileExists", () => {
    const tempDir = join(tmpdir(), "hyperfleet-test-" + Date.now());
    const testFile = join(tempDir, "test-kernel.img");

    beforeEach(() => {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(testFile, "test content");
    });

    afterEach(() => {
      try {
        unlinkSync(testFile);
        rmdirSync(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    });

    it("returns ok for existing file", async () => {
      const result = await validateFileExists(testFile);
      expect(result.isOk()).toBe(true);
    });

    it("returns NotFoundError for non-existent file", async () => {
      const result = await validateFileExists("/nonexistent/path/file.img");
      expect(result.isErr()).toBe(true);
      expect(NotFoundError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("/nonexistent/path/file.img");
    });
  });

  describe("validateKernelPath", () => {
    const tempDir = join(tmpdir(), "hyperfleet-kernel-test-" + Date.now());
    const kernelFile = join(tempDir, "vmlinux");

    beforeEach(() => {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(kernelFile, "fake kernel");
    });

    afterEach(() => {
      try {
        unlinkSync(kernelFile);
        rmdirSync(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    });

    it("accepts valid kernel path", async () => {
      const result = await validateKernelPath(kernelFile);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(kernelFile);
    });

    it("rejects kernel path with traversal", async () => {
      const result = await validateKernelPath("/../etc/passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("returns ValidationError for non-existent kernel", async () => {
      const result = await validateKernelPath("/nonexistent/vmlinux");
      expect(result.isErr()).toBe(true);
      expect(ValidationError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("Kernel image not found");
    });
  });

  describe("validateRootfsPath", () => {
    const tempDir = join(tmpdir(), "hyperfleet-rootfs-test-" + Date.now());
    const rootfsFile = join(tempDir, "rootfs.ext4");

    beforeEach(() => {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(rootfsFile, "fake rootfs");
    });

    afterEach(() => {
      try {
        unlinkSync(rootfsFile);
        rmdirSync(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    });

    it("accepts valid rootfs path", async () => {
      const result = await validateRootfsPath(rootfsFile);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(rootfsFile);
    });

    it("rejects rootfs path with traversal", async () => {
      const result = await validateRootfsPath("/../etc/passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("returns ValidationError for non-existent rootfs", async () => {
      const result = await validateRootfsPath("/nonexistent/rootfs.ext4");
      expect(result.isErr()).toBe(true);
      expect(ValidationError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("Rootfs image not found");
    });
  });

  describe("validateMachinePaths", () => {
    const tempDir = join(tmpdir(), "hyperfleet-machine-test-" + Date.now());
    const kernelFile = join(tempDir, "vmlinux");
    const rootfsFile = join(tempDir, "rootfs.ext4");

    beforeEach(() => {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(kernelFile, "fake kernel");
      writeFileSync(rootfsFile, "fake rootfs");
    });

    afterEach(() => {
      try {
        unlinkSync(kernelFile);
        unlinkSync(rootfsFile);
        rmdirSync(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    });

    it("validates both kernel and rootfs paths", async () => {
      const result = await validateMachinePaths(kernelFile, rootfsFile);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().kernelPath).toBe(kernelFile);
      expect(result.unwrap().rootfsPath).toBe(rootfsFile);
    });

    it("validates kernel only when rootfs is null", async () => {
      const result = await validateMachinePaths(kernelFile, null);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().kernelPath).toBe(kernelFile);
      expect(result.unwrap().rootfsPath).toBeUndefined();
    });

    it("fails fast on invalid kernel path", async () => {
      const result = await validateMachinePaths("/../etc/passwd", rootfsFile);
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("fails on invalid rootfs path after validating kernel", async () => {
      const result = await validateMachinePaths(kernelFile, "/../etc/passwd");
      expect(result.isErr()).toBe(true);
      expect(PathTraversalError.is(result.error)).toBe(true);
    });

    it("returns error for non-existent kernel", async () => {
      const result = await validateMachinePaths("/nonexistent/vmlinux", rootfsFile);
      expect(result.isErr()).toBe(true);
      expect(ValidationError.is(result.error)).toBe(true);
    });
  });
});
