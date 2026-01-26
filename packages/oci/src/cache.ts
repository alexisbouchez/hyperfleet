import { Result } from "better-result";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@hyperfleet/logger";
import { CacheError, type CacheEntry, type CacheIndex } from "./types.js";

const CACHE_INDEX_FILE = "cache-index.json";
const CACHE_VERSION = 1;

/**
 * Manages the OCI image cache
 */
export class ImageCache {
  private cacheDir: string;
  private maxSizeBytes: number;
  private indexPath: string;
  private logger?: Logger;
  private index: CacheIndex | null = null;

  constructor(
    cacheDir: string,
    maxSizeBytes: number = 10 * 1024 * 1024 * 1024,
    logger?: Logger
  ) {
    this.cacheDir = cacheDir;
    this.maxSizeBytes = maxSizeBytes;
    this.indexPath = join(cacheDir, CACHE_INDEX_FILE);
    this.logger = logger;
  }

  /**
   * Initialize the cache directory
   */
  async init(): Promise<Result<void, CacheError>> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await this.loadIndex();
      return Result.ok(undefined);
    } catch (error) {
      return Result.err(
        new CacheError({
          message: "Failed to initialize cache",
          cause: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  /**
   * Load the cache index from disk
   */
  private async loadIndex(): Promise<void> {
    if (!existsSync(this.indexPath)) {
      this.index = { version: CACHE_VERSION, entries: {} };
      return;
    }

    try {
      const data = await readFile(this.indexPath, "utf-8");
      this.index = JSON.parse(data);

      // Migration check
      if (this.index!.version !== CACHE_VERSION) {
        this.logger?.warn("Cache index version mismatch, resetting cache", {
          found: this.index!.version,
          expected: CACHE_VERSION,
        });
        this.index = { version: CACHE_VERSION, entries: {} };
      }
    } catch {
      this.logger?.warn("Failed to load cache index, starting fresh");
      this.index = { version: CACHE_VERSION, entries: {} };
    }
  }

  /**
   * Save the cache index to disk
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;

    try {
      await writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch (error) {
      this.logger?.error("Failed to save cache index", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get a cached image by its normalized reference
   */
  async get(
    normalizedRef: string
  ): Promise<Result<CacheEntry | null, CacheError>> {
    if (!this.index) {
      await this.loadIndex();
    }

    const entry = this.index!.entries[normalizedRef];
    if (!entry) {
      return Result.ok(null);
    }

    // Verify the file still exists
    if (!existsSync(entry.rootfsPath)) {
      this.logger?.warn("Cached file missing, removing entry", {
        ref: normalizedRef,
        path: entry.rootfsPath,
      });
      delete this.index!.entries[normalizedRef];
      await this.saveIndex();
      return Result.ok(null);
    }

    // Update last accessed time
    entry.lastAccessedAt = new Date().toISOString();
    await this.saveIndex();

    return Result.ok(entry);
  }

  /**
   * Add or update a cache entry
   */
  async put(
    normalizedRef: string,
    rootfsPath: string,
    digest: string,
    sizeBytes: number
  ): Promise<Result<CacheEntry, CacheError>> {
    if (!this.index) {
      await this.loadIndex();
    }

    const now = new Date().toISOString();
    const entry: CacheEntry = {
      ref: normalizedRef,
      digest,
      rootfsPath,
      sizeBytes,
      cachedAt: now,
      lastAccessedAt: now,
    };

    this.index!.entries[normalizedRef] = entry;

    // Enforce cache size limit
    await this.enforceLimit();

    await this.saveIndex();

    this.logger?.debug("Added image to cache", {
      ref: normalizedRef,
      digest: digest.slice(0, 16),
      sizeMiB: Math.round(sizeBytes / 1024 / 1024),
    });

    return Result.ok(entry);
  }

  /**
   * Remove an entry from the cache
   */
  async remove(
    normalizedRef: string
  ): Promise<Result<boolean, CacheError>> {
    if (!this.index) {
      await this.loadIndex();
    }

    const entry = this.index!.entries[normalizedRef];
    if (!entry) {
      return Result.ok(false);
    }

    // Delete the file
    try {
      if (existsSync(entry.rootfsPath)) {
        await unlink(entry.rootfsPath);
      }
    } catch (error) {
      this.logger?.warn("Failed to delete cached file", {
        path: entry.rootfsPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    delete this.index!.entries[normalizedRef];
    await this.saveIndex();

    return Result.ok(true);
  }

  /**
   * Get total cache size in bytes
   */
  async getTotalSize(): Promise<number> {
    if (!this.index) {
      await this.loadIndex();
    }

    return Object.values(this.index!.entries).reduce(
      (sum, entry) => sum + entry.sizeBytes,
      0
    );
  }

  /**
   * Enforce cache size limit using LRU eviction
   */
  private async enforceLimit(): Promise<void> {
    const totalSize = await this.getTotalSize();
    if (totalSize <= this.maxSizeBytes) {
      return;
    }

    this.logger?.info("Cache size exceeded, evicting old entries", {
      currentSizeMiB: Math.round(totalSize / 1024 / 1024),
      maxSizeMiB: Math.round(this.maxSizeBytes / 1024 / 1024),
    });

    // Sort entries by last accessed time (oldest first)
    const sortedEntries = Object.entries(this.index!.entries).sort(
      ([, a], [, b]) =>
        new Date(a.lastAccessedAt).getTime() -
        new Date(b.lastAccessedAt).getTime()
    );

    let currentSize = totalSize;
    for (const [ref] of sortedEntries) {
      if (currentSize <= this.maxSizeBytes * 0.9) {
        // Leave 10% headroom
        break;
      }

      const entry = this.index!.entries[ref];
      currentSize -= entry.sizeBytes;

      await this.remove(ref);
      this.logger?.debug("Evicted cache entry", { ref });
    }
  }

  /**
   * Generate the path for a new cached rootfs
   */
  getRootfsPath(cacheKey: string): string {
    return join(this.cacheDir, `${cacheKey}.ext4`);
  }

  /**
   * Get path for temporary working directory
   */
  getTempDir(cacheKey: string): string {
    return join(this.cacheDir, "tmp", cacheKey);
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<Result<void, CacheError>> {
    if (!this.index) {
      await this.loadIndex();
    }

    for (const ref of Object.keys(this.index!.entries)) {
      await this.remove(ref);
    }

    return Result.ok(undefined);
  }

  /**
   * List all cached images
   */
  async list(): Promise<CacheEntry[]> {
    if (!this.index) {
      await this.loadIndex();
    }

    return Object.values(this.index!.entries);
  }
}
