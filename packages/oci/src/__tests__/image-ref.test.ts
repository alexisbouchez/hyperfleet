import { describe, it, expect } from "bun:test";
import { parseImageRef, toSkopeoRef, toCacheKey } from "../image-ref";

describe("parseImageRef", () => {
  describe("Docker Hub images", () => {
    it("parses short form (alpine)", () => {
      const result = parseImageRef("alpine");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("docker.io");
      expect(ref.repository).toBe("library/alpine");
      expect(ref.tag).toBe("latest");
      expect(ref.digest).toBeUndefined();
      expect(ref.normalized).toBe("docker.io/library/alpine:latest");
    });

    it("parses short form with tag (alpine:3.18)", () => {
      const result = parseImageRef("alpine:3.18");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("docker.io");
      expect(ref.repository).toBe("library/alpine");
      expect(ref.tag).toBe("3.18");
      expect(ref.normalized).toBe("docker.io/library/alpine:3.18");
    });

    it("parses user repository (myuser/myimage)", () => {
      const result = parseImageRef("myuser/myimage");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("docker.io");
      expect(ref.repository).toBe("myuser/myimage");
      expect(ref.tag).toBe("latest");
      expect(ref.normalized).toBe("docker.io/myuser/myimage:latest");
    });

    it("parses user repository with tag (myuser/myimage:v1.0)", () => {
      const result = parseImageRef("myuser/myimage:v1.0");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("docker.io");
      expect(ref.repository).toBe("myuser/myimage");
      expect(ref.tag).toBe("v1.0");
      expect(ref.normalized).toBe("docker.io/myuser/myimage:v1.0");
    });
  });

  describe("Custom registry images", () => {
    it("parses ghcr.io image", () => {
      const result = parseImageRef("ghcr.io/owner/repo:v1.0");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("ghcr.io");
      expect(ref.repository).toBe("owner/repo");
      expect(ref.tag).toBe("v1.0");
      expect(ref.normalized).toBe("ghcr.io/owner/repo:v1.0");
    });

    it("parses gcr.io image", () => {
      const result = parseImageRef("gcr.io/project/image");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("gcr.io");
      expect(ref.repository).toBe("project/image");
      expect(ref.tag).toBe("latest");
      expect(ref.normalized).toBe("gcr.io/project/image:latest");
    });

    it("parses registry with port", () => {
      const result = parseImageRef("localhost:5000/myimage:latest");
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("localhost:5000");
      expect(ref.repository).toBe("myimage");
      expect(ref.tag).toBe("latest");
      expect(ref.normalized).toBe("localhost:5000/myimage:latest");
    });
  });

  describe("Images with digest", () => {
    it("parses image with digest", () => {
      const digest = "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const result = parseImageRef(`alpine@${digest}`);
      expect(result.isOk()).toBe(true);

      const ref = result.unwrap();
      expect(ref.registry).toBe("docker.io");
      expect(ref.repository).toBe("library/alpine");
      expect(ref.tag).toBeUndefined();
      expect(ref.digest).toBe(digest);
      expect(ref.normalized).toBe(`docker.io/library/alpine@${digest}`);
    });
  });

  describe("Error cases", () => {
    it("rejects empty string", () => {
      const result = parseImageRef("");
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain("empty");
      }
    });

    it("rejects whitespace only", () => {
      const result = parseImageRef("   ");
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain("empty");
      }
    });

    it("rejects invalid digest format", () => {
      const result = parseImageRef("alpine@invalid");
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain("digest");
      }
    });
  });
});

describe("toSkopeoRef", () => {
  it("converts to docker:// format", () => {
    const result = parseImageRef("alpine:3.18");
    expect(result.isOk()).toBe(true);

    const skopeoRef = toSkopeoRef(result.unwrap());
    expect(skopeoRef).toBe("docker://docker.io/library/alpine:3.18");
  });
});

describe("toCacheKey", () => {
  it("generates safe filename", () => {
    const result = parseImageRef("ghcr.io/owner/repo:v1.0");
    expect(result.isOk()).toBe(true);

    const cacheKey = toCacheKey(result.unwrap());
    expect(cacheKey).toBe("ghcr.io_owner_repo_v1.0");
    expect(cacheKey).not.toContain("/");
    expect(cacheKey).not.toContain(":");
  });

  it("handles digest", () => {
    const digest = "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const result = parseImageRef(`alpine@${digest}`);
    expect(result.isOk()).toBe(true);

    const cacheKey = toCacheKey(result.unwrap());
    expect(cacheKey).not.toContain("@");
    expect(cacheKey).toContain("_at_");
  });
});
