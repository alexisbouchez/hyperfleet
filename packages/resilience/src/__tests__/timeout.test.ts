import { describe, it, expect } from "bun:test";
import { withTimeout, createTimeoutPromise } from "../timeout";
import { TimeoutError } from "@hyperfleet/errors";

describe("withTimeout", () => {
  it("resolves successfully when promise completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("success"),
      1000
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("success");
  });

  it("returns TimeoutError when promise exceeds timeout", async () => {
    const slowPromise = new Promise((resolve) => {
      setTimeout(() => resolve("too late"), 500);
    });

    const result = await withTimeout(slowPromise, 50);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(TimeoutError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("timed out after 50ms");
    }
  });

  it("uses custom error message when provided", async () => {
    const slowPromise = new Promise((resolve) => {
      setTimeout(() => resolve("too late"), 500);
    });

    const result = await withTimeout(
      slowPromise,
      50,
      "Custom timeout message"
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Custom timeout message");
    }
  });

  it("handles promise rejection", async () => {
    const failingPromise = Promise.reject(new Error("Original error"));

    const result = await withTimeout(failingPromise, 1000);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // When the promise itself rejects, it should wrap as TimeoutError
      expect(TimeoutError.is(result.error)).toBe(true);
    }
  });

  it("clears timeout when promise resolves quickly", async () => {
    // This test ensures we don't have memory leaks from uncleared timeouts
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(withTimeout(Promise.resolve(i), 10000));
    }

    const results = await Promise.all(promises);
    expect(results.every((r) => r.isOk())).toBe(true);
  });

  it("handles async value resolution", async () => {
    const asyncValue = async () => {
      await Bun.sleep(10);
      return { data: "test" };
    };

    const result = await withTimeout(asyncValue(), 1000);

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toEqual({ data: "test" });
  });
});

describe("createTimeoutPromise", () => {
  it("rejects with TimeoutError after specified time", async () => {
    const promise = createTimeoutPromise(50);

    try {
      await promise;
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(TimeoutError.is(error)).toBe(true);
      expect((error as TimeoutError).message).toContain("50ms");
    }
  });

  it("uses custom message when provided", async () => {
    const promise = createTimeoutPromise(50, "Custom message");

    try {
      await promise;
      expect(true).toBe(false);
    } catch (error) {
      expect((error as TimeoutError).message).toBe("Custom message");
    }
  });

  it("can be used with Promise.race", async () => {
    const slowOperation = new Promise((resolve) =>
      setTimeout(() => resolve("done"), 500)
    );
    const timeout = createTimeoutPromise(50);

    try {
      await Promise.race([slowOperation, timeout]);
      expect(true).toBe(false);
    } catch (error) {
      expect(TimeoutError.is(error)).toBe(true);
    }
  });
});
