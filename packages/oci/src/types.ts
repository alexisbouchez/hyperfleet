import { TaggedError } from "better-result";

/**
 * Parsed and normalized OCI image reference
 */
export interface ImageReference {
  /** Registry hostname (e.g., "docker.io", "ghcr.io") */
  registry: string;
  /** Repository path (e.g., "library/alpine", "myuser/myimage") */
  repository: string;
  /** Image tag (e.g., "latest", "3.18") */
  tag?: string;
  /** Image digest (e.g., "sha256:...") */
  digest?: string;
  /** Full normalized reference string */
  normalized: string;
}

/**
 * Metadata about a converted OCI image
 */
export interface ConvertedImage {
  /** Original image reference */
  ref: ImageReference;
  /** Path to the ext4 rootfs file */
  rootfsPath: string;
  /** Image digest for cache validation */
  digest: string;
  /** ISO timestamp when image was cached */
  cachedAt: string;
  /** Size of the rootfs in bytes */
  sizeBytes: number;
}

/**
 * Configuration for the OCI image service
 */
export interface ImageServiceConfig {
  /** Directory for caching converted images */
  cacheDir: string;
  /** Maximum cache size in bytes (default: 10GB) */
  maxCacheSize?: number;
  /** Default rootfs size in MiB (default: 1024) */
  defaultRootfsSizeMib?: number;
}

/**
 * Registry authentication credentials
 */
export interface RegistryAuth {
  username: string;
  password: string;
}

/**
 * Options for image conversion
 */
export interface ConvertOptions {
  /** Size of the output ext4 image in MiB */
  sizeMib?: number;
  /** Registry authentication */
  auth?: RegistryAuth;
}

/**
 * Cache entry stored in cache index
 */
export interface CacheEntry {
  ref: string;
  digest: string;
  rootfsPath: string;
  sizeBytes: number;
  cachedAt: string;
  lastAccessedAt: string;
}

/**
 * Cache index file format
 */
export interface CacheIndex {
  version: number;
  entries: Record<string, CacheEntry>;
}

// Error types
export const ImageNotFoundError = TaggedError("ImageNotFoundError")<{
  message: string;
  imageRef: string;
}>();

export type ImageNotFoundError = InstanceType<typeof ImageNotFoundError>;

export const ImagePullError = TaggedError("ImagePullError")<{
  message: string;
  imageRef: string;
  cause?: string;
}>();

export type ImagePullError = InstanceType<typeof ImagePullError>;

export const ImageConvertError = TaggedError("ImageConvertError")<{
  message: string;
  imageRef: string;
  cause?: string;
}>();

export type ImageConvertError = InstanceType<typeof ImageConvertError>;

export const InvalidImageRefError = TaggedError("InvalidImageRefError")<{
  message: string;
  imageRef: string;
}>();

export type InvalidImageRefError = InstanceType<typeof InvalidImageRefError>;

export const CacheError = TaggedError("CacheError")<{
  message: string;
  cause?: string;
}>();

export type CacheError = InstanceType<typeof CacheError>;

export type OciError =
  | ImageNotFoundError
  | ImagePullError
  | ImageConvertError
  | InvalidImageRefError
  | CacheError;
