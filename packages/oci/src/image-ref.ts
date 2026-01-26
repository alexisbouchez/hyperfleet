import { Result } from "better-result";
import { InvalidImageRefError, type ImageReference } from "./types.js";

const DEFAULT_REGISTRY = "docker.io";
const DEFAULT_TAG = "latest";
const DOCKER_OFFICIAL_REPO_PREFIX = "library/";

// Regex patterns for parsing image references
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TAG_PATTERN = /^[\w][\w.-]{0,127}$/;
const REGISTRY_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

/**
 * Parse an OCI image reference string into its components
 *
 * Supports formats:
 * - alpine (short form, defaults to docker.io/library/alpine:latest)
 * - alpine:3.18
 * - myuser/myimage
 * - myuser/myimage:v1.0
 * - ghcr.io/owner/repo:tag
 * - docker.io/library/alpine@sha256:...
 *
 * @param ref - Image reference string to parse
 * @returns Parsed ImageReference or error
 */
export function parseImageRef(
  ref: string
): Result<ImageReference, InvalidImageRefError> {
  if (!ref || ref.trim() === "") {
    return Result.err(
      new InvalidImageRefError({
        message: "Image reference cannot be empty",
        imageRef: ref,
      })
    );
  }

  const trimmed = ref.trim();

  // Check for digest
  let digest: string | undefined;
  let refWithoutDigest = trimmed;

  const digestIndex = trimmed.indexOf("@");
  if (digestIndex !== -1) {
    digest = trimmed.slice(digestIndex + 1);
    refWithoutDigest = trimmed.slice(0, digestIndex);

    if (!DIGEST_PATTERN.test(digest)) {
      return Result.err(
        new InvalidImageRefError({
          message: `Invalid digest format: ${digest}`,
          imageRef: ref,
        })
      );
    }
  }

  // Check for tag
  let tag: string | undefined;
  let refWithoutTag = refWithoutDigest;

  // Only look for tag if no digest (digest takes precedence)
  if (!digest) {
    const tagIndex = refWithoutDigest.lastIndexOf(":");
    // Make sure the colon is not part of a port number (after registry)
    const slashIndex = refWithoutDigest.indexOf("/");
    if (tagIndex !== -1 && (slashIndex === -1 || tagIndex > slashIndex)) {
      const possibleTag = refWithoutDigest.slice(tagIndex + 1);
      // Verify it's a tag and not a port
      if (TAG_PATTERN.test(possibleTag) && !/^\d+$/.test(possibleTag)) {
        tag = possibleTag;
        refWithoutTag = refWithoutDigest.slice(0, tagIndex);
      }
    }
  }

  // Parse registry and repository
  let registry = DEFAULT_REGISTRY;
  let repository = refWithoutTag;

  const firstSlash = refWithoutTag.indexOf("/");
  if (firstSlash !== -1) {
    const possibleRegistry = refWithoutTag.slice(0, firstSlash);
    // Check if it looks like a registry (contains . or : or is localhost)
    if (
      possibleRegistry.includes(".") ||
      possibleRegistry.includes(":") ||
      possibleRegistry === "localhost"
    ) {
      registry = possibleRegistry;
      repository = refWithoutTag.slice(firstSlash + 1);
    }
  }

  // Validate registry format
  const registryWithoutPort = registry.split(":")[0];
  if (
    registryWithoutPort !== "localhost" &&
    !REGISTRY_PATTERN.test(registryWithoutPort)
  ) {
    return Result.err(
      new InvalidImageRefError({
        message: `Invalid registry format: ${registry}`,
        imageRef: ref,
      })
    );
  }

  // For Docker Hub, add library/ prefix for official images
  if (registry === DEFAULT_REGISTRY && !repository.includes("/")) {
    repository = DOCKER_OFFICIAL_REPO_PREFIX + repository;
  }

  // Validate repository
  if (!repository || repository === "") {
    return Result.err(
      new InvalidImageRefError({
        message: "Repository name cannot be empty",
        imageRef: ref,
      })
    );
  }

  // Default tag if no tag and no digest
  if (!tag && !digest) {
    tag = DEFAULT_TAG;
  }

  // Build normalized reference
  const normalized = buildNormalizedRef(registry, repository, tag, digest);

  return Result.ok({
    registry,
    repository,
    tag,
    digest,
    normalized,
  });
}

/**
 * Build a normalized image reference string
 */
function buildNormalizedRef(
  registry: string,
  repository: string,
  tag?: string,
  digest?: string
): string {
  let ref = `${registry}/${repository}`;

  if (digest) {
    ref += `@${digest}`;
  } else if (tag) {
    ref += `:${tag}`;
  }

  return ref;
}

/**
 * Convert an ImageReference back to a string suitable for skopeo
 */
export function toSkopeoRef(ref: ImageReference): string {
  // Skopeo uses docker:// prefix for Docker/OCI registries
  return `docker://${ref.normalized}`;
}

/**
 * Generate a safe filename for caching based on image reference
 */
export function toCacheKey(ref: ImageReference): string {
  // Replace special characters with safe alternatives
  return ref.normalized
    .replace(/\//g, "_")
    .replace(/:/g, "_")
    .replace(/@/g, "_at_");
}
