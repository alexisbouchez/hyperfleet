import { describe, it, expect } from "bun:test";
import { Result } from "better-result";
import { withRetry, withRetryThrows } from "../retry";

describe("withRetry", () => {
  it("returns success on first attempt when function succeeds", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return Result.ok("success");
    };

    const result = await withRetry(fn, { maxAttempts: 3 });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("success");
    expect(attempts).toBe(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        return Result.err(new Error(`Attempt ${attempts} failed`));
      }
      return Result.ok("success");
    };

    const result = await withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 10,
    });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("success");
    expect(attempts).toBe(3);
  });

  it("returns last error after max attempts", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return Result.err(new Error(`Attempt ${attempts} failed`));
    };

    const result = await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Attempt 3 failed");
    }
    expect(attempts).toBe(3);
  });

  it("respects custom retryOn predicate", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return Result.err({
        type: attempts === 1 ? "retryable" : "permanent",
        message: `Error ${attempts}`,
      });
    };

    const result = await withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      retryOn: (error) =>
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "retryable",
    });

    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(2); // Stopped after getting non-retryable error
  });

  it("applies exponential backoff", async () => {
    let attempts = 0;
    const timestamps: number[] = [];

    const fn = async () => {
      attempts++;
      timestamps.push(Date.now());
      if (attempts < 3) {
        return Result.err(new Error("fail"));
      }
      return Result.ok("success");
    };

    await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 50,
      backoffMultiplier: 2,
      jitter: false,
    });

    // First retry should be after ~50ms, second after ~100ms
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];

    expect(delay1).toBeGreaterThanOrEqual(45);
    expect(delay2).toBeGreaterThanOrEqual(90);
    expect(delay2).toBeGreaterThan(delay1);
  });

  it("respects maxDelayMs cap", async () => {
    let attempts = 0;
    const timestamps: number[] = [];

    const fn = async () => {
      attempts++;
      timestamps.push(Date.now());
      if (attempts < 4) {
        return Result.err(new Error("fail"));
      }
      return Result.ok("success");
    };

    await withRetry(fn, {
      maxAttempts: 4,
      initialDelayMs: 50,
      maxDelayMs: 75,
      backoffMultiplier: 2,
      jitter: false,
    });

    // All delays should be <= maxDelayMs
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];
    const delay3 = timestamps[3] - timestamps[2];

    expect(delay1).toBeLessThanOrEqual(85); // 50ms + buffer
    expect(delay2).toBeLessThanOrEqual(85); // Capped at 75ms + buffer
    expect(delay3).toBeLessThanOrEqual(85);
  });

  it("uses default options when not provided", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) {
        return Result.err(new Error("fail"));
      }
      return Result.ok("success");
    };

    const result = await withRetry(fn);

    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe("withRetryThrows", () => {
  it("returns success when function does not throw", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return "success";
    };

    const result = await withRetryThrows(
      fn,
      (e) => new Error(`Wrapped: ${e}`),
      { maxAttempts: 3 }
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("success");
    expect(attempts).toBe(1);
  });

  it("retries on thrown errors and eventually succeeds", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`Attempt ${attempts}`);
      }
      return "success";
    };

    const result = await withRetryThrows(
      fn,
      (e) => ({ wrapped: true, original: e }),
      { maxAttempts: 5, initialDelayMs: 10 }
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("success");
    expect(attempts).toBe(3);
  });

  it("wraps error with provided wrapper function", async () => {
    const fn = async () => {
      throw new Error("Original");
    };

    const result = await withRetryThrows(
      fn,
      (e) => ({ type: "wrapped", message: String(e) }),
      { maxAttempts: 1 }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        type: "wrapped",
        message: "Error: Original",
      });
    }
  });

  it("respects custom retryOn predicate", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw { code: attempts === 1 ? "ECONNRESET" : "EPERM" };
    };

    await withRetryThrows(
      fn,
      (e) => e,
      {
        maxAttempts: 5,
        initialDelayMs: 10,
        retryOn: (error) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ECONNRESET",
      }
    );

    expect(attempts).toBe(2); // Stopped after non-retryable error
  });
});
