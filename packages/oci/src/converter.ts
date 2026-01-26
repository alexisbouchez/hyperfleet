import { Result } from "better-result";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@hyperfleet/logger";
import {
  ImagePullError,
  ImageConvertError,
  type ImageReference,
  type RegistryAuth,
} from "./types.js";
import { toSkopeoRef } from "./image-ref.js";

const DEFAULT_ROOTFS_SIZE_MIB = 1024;

/**
 * Get the path to the init binary based on architecture
 */
function getInitBinaryPath(): string | null {
  // Get the directory of this module
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Look for init binary relative to project root
  // Go up from packages/oci/src to project root, then to assets/init
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const initPath = join(__dirname, "..", "..", "..", "assets", "init", `init-${arch}`);

  if (existsSync(initPath)) {
    return initPath;
  }

  // Try environment variable as fallback
  const envPath = process.env.HYPERFLEET_INIT_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  return null;
}

/**
 * Converts OCI images to ext4 rootfs using skopeo and umoci
 */
export class ImageConverter {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Pull an OCI image and convert it to ext4 rootfs
   *
   * @param ref - Parsed image reference
   * @param outputPath - Path where the ext4 image should be written
   * @param tempDir - Temporary directory for intermediate files
   * @param sizeMib - Size of the ext4 image in MiB
   * @param auth - Optional registry authentication
   * @returns Result with the image digest or error
   */
  async convert(
    ref: ImageReference,
    outputPath: string,
    tempDir: string,
    sizeMib: number = DEFAULT_ROOTFS_SIZE_MIB,
    auth?: RegistryAuth
  ): Promise<
    Result<
      string,
      ImagePullError | ImageConvertError
    >
  > {
    const ociDir = join(tempDir, "oci");
    const rootfsDir = join(tempDir, "rootfs");

    try {
      // Create working directories
      await mkdir(tempDir, { recursive: true });
      await mkdir(ociDir, { recursive: true });

      this.logger?.info("Pulling OCI image", {
        image: ref.normalized,
        outputPath,
        sizeMib,
      });

      // Step 1: Pull image with skopeo
      const pullResult = await this.pullImage(ref, ociDir, auth);
      if (pullResult.isErr()) {
        return Result.err(pullResult.error);
      }

      const digest = pullResult.unwrap();

      // Step 2: Unpack with umoci
      const unpackResult = await this.unpackImage(ociDir, rootfsDir, ref.tag);
      if (unpackResult.isErr()) {
        return Result.err(unpackResult.error);
      }

      // Step 3: Inject init binary
      const injectResult = await this.injectInit(rootfsDir);
      if (injectResult.isErr()) {
        return Result.err(injectResult.error);
      }

      // Step 4: Configure network (DNS)
      const networkResult = await this.configureNetwork(rootfsDir);
      if (networkResult.isErr()) {
        return Result.err(networkResult.error);
      }

      // Step 5: Create ext4 filesystem
      const createResult = await this.createExt4(
        rootfsDir,
        outputPath,
        sizeMib
      );
      if (createResult.isErr()) {
        return Result.err(createResult.error);
      }

      this.logger?.info("Successfully converted OCI image", {
        image: ref.normalized,
        digest: digest.slice(0, 16),
        outputPath,
      });

      return Result.ok(digest);
    } finally {
      // Cleanup temp directory
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true }).catch((e) => {
          this.logger?.warn("Failed to cleanup temp directory", {
            tempDir,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
    }
  }

  /**
   * Pull image using skopeo
   */
  private async pullImage(
    ref: ImageReference,
    ociDir: string,
    auth?: RegistryAuth
  ): Promise<Result<string, ImagePullError>> {
    const args = ["copy", "--quiet"];

    // Add auth if provided
    if (auth) {
      args.push("--src-creds", `${auth.username}:${auth.password}`);
    }

    args.push(toSkopeoRef(ref), `oci:${ociDir}:latest`);

    this.logger?.debug("Running skopeo", { args: args.join(" ") });

    const proc = Bun.spawn(["skopeo", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      this.logger?.error("skopeo failed", { exitCode, stderr });

      // Check for common errors
      if (
        stderr.includes("manifest unknown") ||
        stderr.includes("not found")
      ) {
        return Result.err(
          new ImagePullError({
            message: `Image not found: ${ref.normalized}`,
            imageRef: ref.normalized,
            cause: stderr,
          })
        );
      }

      if (stderr.includes("unauthorized") || stderr.includes("authentication")) {
        return Result.err(
          new ImagePullError({
            message: `Authentication required for ${ref.normalized}`,
            imageRef: ref.normalized,
            cause: stderr,
          })
        );
      }

      return Result.err(
        new ImagePullError({
          message: `Failed to pull image: ${ref.normalized}`,
          imageRef: ref.normalized,
          cause: stderr,
        })
      );
    }

    // Get digest from the pulled image
    const digest = await this.getImageDigest(ociDir);
    return Result.ok(digest);
  }

  /**
   * Get the digest of the pulled image
   */
  private async getImageDigest(ociDir: string): Promise<string> {
    try {
      const indexPath = join(ociDir, "index.json");
      const indexData = await Bun.file(indexPath).json();

      if (indexData.manifests?.[0]?.digest) {
        return indexData.manifests[0].digest;
      }
    } catch {
      // Ignore errors, return empty digest
    }

    return `sha256:${Date.now().toString(16)}`;
  }

  /**
   * Unpack image using umoci
   */
  private async unpackImage(
    ociDir: string,
    rootfsDir: string,
    tag?: string
  ): Promise<Result<void, ImageConvertError>> {
    const imageRef = `${ociDir}:${tag || "latest"}`;

    const args = ["unpack", "--rootless", "--image", imageRef, rootfsDir];

    this.logger?.debug("Running umoci", { args: args.join(" ") });

    const proc = Bun.spawn(["umoci", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      this.logger?.error("umoci failed", { exitCode, stderr });
      return Result.err(
        new ImageConvertError({
          message: "Failed to unpack OCI image",
          imageRef: imageRef,
          cause: stderr,
        })
      );
    }

    return Result.ok(undefined);
  }

  /**
   * Inject init binary into the rootfs
   */
  private async injectInit(
    rootfsDir: string
  ): Promise<Result<void, ImageConvertError>> {
    const initPath = getInitBinaryPath();

    if (!initPath) {
      this.logger?.warn(
        "No init binary found, VM may not boot correctly. " +
          "Build the init with 'make' in guest/ or set HYPERFLEET_INIT_PATH"
      );
      return Result.ok(undefined);
    }

    const rootfs = join(rootfsDir, "rootfs");
    const destPath = join(rootfs, "init");

    this.logger?.debug("Injecting init binary", {
      source: initPath,
      dest: destPath,
    });

    try {
      await copyFile(initPath, destPath);
      await chmod(destPath, 0o755);
      return Result.ok(undefined);
    } catch (error) {
      return Result.err(
        new ImageConvertError({
          message: "Failed to inject init binary",
          imageRef: "",
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  /**
   * Configure network settings in the rootfs (DNS, etc.)
   */
  private async configureNetwork(
    rootfsDir: string
  ): Promise<Result<void, ImageConvertError>> {
    const rootfs = join(rootfsDir, "rootfs");
    const etcDir = join(rootfs, "etc");
    const resolvConf = join(etcDir, "resolv.conf");

    this.logger?.debug("Configuring network", { resolvConf });

    try {
      // Ensure /etc directory exists
      await mkdir(etcDir, { recursive: true });

      // Write resolv.conf with Google DNS and Cloudflare DNS
      const dnsConfig = [
        "# Generated by Hyperfleet",
        "nameserver 8.8.8.8",
        "nameserver 8.8.4.4",
        "nameserver 1.1.1.1",
        "",
      ].join("\n");

      await writeFile(resolvConf, dnsConfig, { mode: 0o644 });

      this.logger?.debug("DNS configuration written", { resolvConf });
      return Result.ok(undefined);
    } catch (error) {
      return Result.err(
        new ImageConvertError({
          message: "Failed to configure network settings",
          imageRef: "",
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  /**
   * Create ext4 filesystem from rootfs directory
   */
  private async createExt4(
    rootfsDir: string,
    outputPath: string,
    sizeMib: number
  ): Promise<Result<void, ImageConvertError>> {
    const rootfs = join(rootfsDir, "rootfs");

    // Create sparse file
    const ddProc = Bun.spawn(
      ["dd", "if=/dev/zero", `of=${outputPath}`, "bs=1M", "count=0", `seek=${sizeMib}`],
      { stdout: "pipe", stderr: "pipe" }
    );

    const ddExitCode = await ddProc.exited;
    if (ddExitCode !== 0) {
      const stderr = await new Response(ddProc.stderr).text();
      return Result.err(
        new ImageConvertError({
          message: "Failed to create sparse file",
          imageRef: "",
          cause: stderr,
        })
      );
    }

    // Format as ext4
    const mkfsProc = Bun.spawn(
      ["mkfs.ext4", "-F", "-d", rootfs, outputPath],
      { stdout: "pipe", stderr: "pipe" }
    );

    const mkfsExitCode = await mkfsProc.exited;
    if (mkfsExitCode !== 0) {
      const stderr = await new Response(mkfsProc.stderr).text();
      return Result.err(
        new ImageConvertError({
          message: "Failed to create ext4 filesystem",
          imageRef: "",
          cause: stderr,
        })
      );
    }

    this.logger?.debug("Created ext4 filesystem", {
      outputPath,
      sizeMib,
    });

    return Result.ok(undefined);
  }

  /**
   * Check if required tools are available
   */
  async checkDependencies(): Promise<
    Result<void, ImageConvertError>
  > {
    const tools = ["skopeo", "umoci", "mkfs.ext4"];
    const missing: string[] = [];

    for (const tool of tools) {
      const proc = Bun.spawn(["which", tool], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        missing.push(tool);
      }
    }

    if (missing.length > 0) {
      return Result.err(
        new ImageConvertError({
          message: `Missing required tools: ${missing.join(", ")}`,
          imageRef: "",
          cause: "Please install the missing tools to use OCI image support",
        })
      );
    }

    return Result.ok(undefined);
  }
}
