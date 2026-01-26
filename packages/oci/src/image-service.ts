import { Result } from "better-result";
import { stat } from "node:fs/promises";
import type { Logger } from "@hyperfleet/logger";
import { parseImageRef, toCacheKey } from "./image-ref.js";
import { ImageCache } from "./cache.js";
import { ImageConverter } from "./converter.js";
import {
  type ImageServiceConfig,
  type ConvertedImage,
  type ConvertOptions,
  type OciError,
} from "./types.js";

const DEFAULT_CACHE_DIR = "/var/lib/hyperfleet/images";
const DEFAULT_MAX_CACHE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
const DEFAULT_ROOTFS_SIZE_MIB = 1024;

/**
 * High-level service for resolving OCI images
 */
export class ImageService {
  private cache: ImageCache;
  private converter: ImageConverter;
  private defaultRootfsSizeMib: number;
  private logger?: Logger;
  private initialized = false;

  constructor(config: ImageServiceConfig, logger?: Logger) {
    this.logger = logger;
    this.defaultRootfsSizeMib = config.defaultRootfsSizeMib ?? DEFAULT_ROOTFS_SIZE_MIB;
    this.cache = new ImageCache(
      config.cacheDir,
      config.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE,
      logger
    );
    this.converter = new ImageConverter(logger);
  }

  /**
   * Create an ImageService with default configuration from environment
   */
  static fromEnv(logger?: Logger): ImageService {
    const config: ImageServiceConfig = {
      cacheDir: process.env.HYPERFLEET_OCI_CACHE_DIR ?? DEFAULT_CACHE_DIR,
      maxCacheSize: process.env.HYPERFLEET_OCI_MAX_CACHE_SIZE
        ? parseInt(process.env.HYPERFLEET_OCI_MAX_CACHE_SIZE, 10)
        : DEFAULT_MAX_CACHE_SIZE,
      defaultRootfsSizeMib: process.env.HYPERFLEET_OCI_DEFAULT_ROOTFS_SIZE_MIB
        ? parseInt(process.env.HYPERFLEET_OCI_DEFAULT_ROOTFS_SIZE_MIB, 10)
        : DEFAULT_ROOTFS_SIZE_MIB,
    };

    return new ImageService(config, logger);
  }

  /**
   * Initialize the service (creates cache directory, checks dependencies)
   */
  async init(): Promise<Result<void, OciError>> {
    if (this.initialized) {
      return Result.ok(undefined);
    }

    // Check for required tools
    const depsResult = await this.converter.checkDependencies();
    if (depsResult.isErr()) {
      return Result.err(depsResult.error);
    }

    // Initialize cache
    const cacheResult = await this.cache.init();
    if (cacheResult.isErr()) {
      return Result.err(cacheResult.error);
    }

    this.initialized = true;
    this.logger?.info("OCI image service initialized");

    return Result.ok(undefined);
  }

  /**
   * Resolve an image reference to a local ext4 rootfs path
   *
   * This will:
   * 1. Parse the image reference
   * 2. Check the cache for an existing conversion
   * 3. If not cached, pull and convert the image
   * 4. Return the path to the ext4 rootfs
   *
   * @param imageRef - Image reference string (e.g., "alpine:latest")
   * @param options - Conversion options
   * @returns ConvertedImage with path to rootfs
   */
  async resolveImage(
    imageRef: string,
    options?: ConvertOptions
  ): Promise<Result<ConvertedImage, OciError>> {
    // Ensure initialized
    if (!this.initialized) {
      const initResult = await this.init();
      if (initResult.isErr()) {
        return Result.err(initResult.error);
      }
    }

    // Parse image reference
    const parseResult = parseImageRef(imageRef);
    if (parseResult.isErr()) {
      return Result.err(parseResult.error);
    }

    const ref = parseResult.unwrap();
    this.logger?.info("Resolving OCI image", { image: ref.normalized });

    // Check cache first
    const cacheResult = await this.cache.get(ref.normalized);
    if (cacheResult.isErr()) {
      return Result.err(cacheResult.error);
    }

    const cached = cacheResult.unwrap();
    if (cached) {
      this.logger?.info("Using cached image", {
        image: ref.normalized,
        path: cached.rootfsPath,
      });

      return Result.ok({
        ref,
        rootfsPath: cached.rootfsPath,
        digest: cached.digest,
        cachedAt: cached.cachedAt,
        sizeBytes: cached.sizeBytes,
      });
    }

    // Not cached, need to pull and convert
    const cacheKey = toCacheKey(ref);
    const outputPath = this.cache.getRootfsPath(cacheKey);
    const tempDir = this.cache.getTempDir(cacheKey);
    const sizeMib = options?.sizeMib ?? this.defaultRootfsSizeMib;

    this.logger?.info("Converting OCI image", {
      image: ref.normalized,
      outputPath,
      sizeMib,
    });

    const convertResult = await this.converter.convert(
      ref,
      outputPath,
      tempDir,
      sizeMib,
      options?.auth
    );

    if (convertResult.isErr()) {
      return Result.err(convertResult.error);
    }

    const digest = convertResult.unwrap();

    // Get file size
    const fileStats = await stat(outputPath);
    const sizeBytes = fileStats.size;

    // Add to cache
    const putResult = await this.cache.put(
      ref.normalized,
      outputPath,
      digest,
      sizeBytes
    );

    if (putResult.isErr()) {
      return Result.err(putResult.error);
    }

    const entry = putResult.unwrap();

    return Result.ok({
      ref,
      rootfsPath: entry.rootfsPath,
      digest: entry.digest,
      cachedAt: entry.cachedAt,
      sizeBytes: entry.sizeBytes,
    });
  }

  /**
   * Clear the image cache
   */
  async clearCache(): Promise<Result<void, OciError>> {
    return this.cache.clear();
  }

  /**
   * List all cached images
   */
  async listCached(): Promise<ConvertedImage[]> {
    const entries = await this.cache.list();
    return entries.map((entry) => {
      // Parse the ref back from the cache entry
      const parseResult = parseImageRef(entry.ref);
      const ref = parseResult.isOk()
        ? parseResult.unwrap()
        : {
            registry: "unknown",
            repository: "unknown",
            normalized: entry.ref,
          };

      return {
        ref,
        rootfsPath: entry.rootfsPath,
        digest: entry.digest,
        cachedAt: entry.cachedAt,
        sizeBytes: entry.sizeBytes,
      };
    });
  }
}

// Singleton instance
let globalImageService: ImageService | null = null;

/**
 * Get or create the global ImageService instance
 */
export function getImageService(logger?: Logger): ImageService {
  if (!globalImageService) {
    globalImageService = ImageService.fromEnv(logger);
  }
  return globalImageService;
}
