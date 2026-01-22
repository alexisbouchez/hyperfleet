import { describe, it, expect, beforeEach } from "bun:test";
import { Result } from "better-result";
import { CircuitBreaker, CircuitOpenError } from "../circuit-breaker";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100,
      halfOpenSuccessThreshold: 2,
    });
  });

  describe("initial state", () => {
    it("starts in closed state", () => {
      expect(breaker.getState()).toBe("closed");
    });

    it("has zero failure count", () => {
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe("closed state", () => {
    it("allows requests to pass through", async () => {
      const result = await breaker.call(() =>
        Promise.resolve(Result.ok("success"))
      );

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe("success");
    });

    it("increments failure count on error", async () => {
      await breaker.call(() => Promise.resolve(Result.err(new Error("fail"))));

      expect(breaker.getFailureCount()).toBe(1);
      expect(breaker.getState()).toBe("closed");
    });

    it("resets failure count on success", async () => {
      await breaker.call(() => Promise.resolve(Result.err(new Error("fail1"))));
      await breaker.call(() => Promise.resolve(Result.err(new Error("fail2"))));

      expect(breaker.getFailureCount()).toBe(2);

      await breaker.call(() => Promise.resolve(Result.ok("success")));

      expect(breaker.getFailureCount()).toBe(0);
    });

    it("opens circuit after reaching failure threshold", async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.call(() => Promise.resolve(Result.err(new Error(`fail${i}`))));
      }

      expect(breaker.getState()).toBe("open");
    });
  });

  describe("open state", () => {
    beforeEach(async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await breaker.call(() => Promise.resolve(Result.err(new Error())));
      }
      expect(breaker.getState()).toBe("open");
    });

    it("rejects requests immediately with CircuitOpenError", async () => {
      const result = await breaker.call(() =>
        Promise.resolve(Result.ok("should not execute"))
      );

      expect(result.isErr()).toBe(true);
      expect(CircuitOpenError.is(result.error)).toBe(true);
      expect((result.error as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
    });

    it("includes retry after time in error", async () => {
      const result = await breaker.call(() =>
        Promise.resolve(Result.ok("test"))
      );

      expect(result.isErr()).toBe(true);
      const error = result.error as CircuitOpenError;
      expect(error.retryAfterMs).toBeLessThanOrEqual(100);
    });

    it("transitions to half-open after reset timeout", async () => {
      await Bun.sleep(150); // Wait for reset timeout

      // Next call should be allowed (half-open)
      const result = await breaker.call(() =>
        Promise.resolve(Result.ok("success"))
      );

      expect(result.isOk()).toBe(true);
      expect(breaker.getState()).toBe("half-open");
    });
  });

  describe("half-open state", () => {
    beforeEach(async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await breaker.call(() => Promise.resolve(Result.err(new Error())));
      }
      // Wait for reset timeout
      await Bun.sleep(150);
      // Make a successful call to enter half-open
      await breaker.call(() => Promise.resolve(Result.ok("first success")));
      expect(breaker.getState()).toBe("half-open");
    });

    it("closes circuit after enough successful calls", async () => {
      // Need 2 successes total, already have 1
      await breaker.call(() => Promise.resolve(Result.ok("second success")));

      expect(breaker.getState()).toBe("closed");
    });

    it("opens circuit immediately on any failure", async () => {
      await breaker.call(() => Promise.resolve(Result.err(new Error("fail"))));

      expect(breaker.getState()).toBe("open");
    });
  });

  describe("reset", () => {
    it("resets to closed state", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await breaker.call(() => Promise.resolve(Result.err(new Error())));
      }
      expect(breaker.getState()).toBe("open");

      breaker.reset();

      expect(breaker.getState()).toBe("closed");
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe("callThrows", () => {
    it("handles successful execution", async () => {
      const result = await breaker.callThrows(
        () => Promise.resolve("success"),
        (e) => new Error(`Wrapped: ${e}`)
      );

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe("success");
    });

    it("wraps thrown errors", async () => {
      const result = await breaker.callThrows(
        () => Promise.reject(new Error("original")),
        (e) => ({ wrapped: true, message: String(e) })
      );

      expect(result.isErr()).toBe(true);
      expect(result.error).toEqual({
        wrapped: true,
        message: "Error: original",
      });
    });

    it("counts failures and opens circuit", async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.callThrows(
          () => Promise.reject(new Error("fail")),
          (e) => e
        );
      }

      expect(breaker.getState()).toBe("open");
    });

    it("returns CircuitOpenError when circuit is open", async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await breaker.callThrows(
          () => Promise.reject(new Error()),
          (e) => e
        );
      }

      const result = await breaker.callThrows(
        () => Promise.resolve("test"),
        (e) => e
      );

      expect(result.isErr()).toBe(true);
      expect(CircuitOpenError.is(result.error)).toBe(true);
    });
  });

  describe("configuration", () => {
    it("uses default options when not provided", () => {
      const defaultBreaker = new CircuitBreaker();

      expect(defaultBreaker.getState()).toBe("closed");
    });

    it("respects custom failure threshold", async () => {
      const customBreaker = new CircuitBreaker({
        failureThreshold: 5,
      });

      for (let i = 0; i < 4; i++) {
        await customBreaker.call(() =>
          Promise.resolve(Result.err(new Error()))
        );
      }

      expect(customBreaker.getState()).toBe("closed");

      await customBreaker.call(() =>
        Promise.resolve(Result.err(new Error()))
      );

      expect(customBreaker.getState()).toBe("open");
    });
  });
});
