/* eslint-disable no-redeclare */
import { Result } from "better-result";
import { TaggedError } from "better-result";
import {
  DEFAULT_CIRCUIT_BREAKER_OPTIONS,
  type CircuitBreakerOptions,
  type CircuitState,
} from "./types.js";

/**
 * Error thrown when circuit breaker is open
 */
export const CircuitOpenError = TaggedError("CircuitOpenError")<{
  message: string;
  retryAfterMs: number;
}>();

export type CircuitOpenError = InstanceType<typeof CircuitOpenError>;

/**
 * Circuit breaker implementation for fault tolerance.
 *
 * States:
 * - closed: Normal operation, requests pass through
 * - open: Circuit tripped, requests fail immediately
 * - half-open: Testing if service recovered
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker({ failureThreshold: 5 });
 *
 * const result = await breaker.call(() => client.fetchData());
 * if (CircuitOpenError.is(result.error)) {
 *   console.log("Service unavailable, retry after:", result.error.retryAfterMs);
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...options };
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get current failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Reset circuit breaker to closed state
   */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @param fn - Async function returning a Result
   * @returns Result from function or CircuitOpenError if circuit is open
   */
  async call<T, E>(
    fn: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | CircuitOpenError>> {
    // Check if circuit should transition from open to half-open
    if (this.state === "open") {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.options.resetTimeoutMs) {
        this.state = "half-open";
        this.successCount = 0;
      } else {
        const retryAfterMs = this.options.resetTimeoutMs - timeSinceFailure;
        return Result.err(
          new CircuitOpenError({
            message: `Circuit breaker is open. Retry after ${retryAfterMs}ms`,
            retryAfterMs,
          })
        );
      }
    }

    // Execute the function
    const result = await fn();

    if (result.isOk()) {
      this.onSuccess();
    } else {
      this.onFailure();
    }

    return result;
  }

  /**
   * Execute a function that throws through the circuit breaker.
   *
   * @param fn - Async function that may throw
   * @param errorWrapper - Function to wrap caught errors
   * @returns Result from function or CircuitOpenError if circuit is open
   */
  async callThrows<T, E>(
    fn: () => Promise<T>,
    errorWrapper: (error: unknown) => E
  ): Promise<Result<T, E | CircuitOpenError>> {
    // Check if circuit should transition from open to half-open
    if (this.state === "open") {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.options.resetTimeoutMs) {
        this.state = "half-open";
        this.successCount = 0;
      } else {
        const retryAfterMs = this.options.resetTimeoutMs - timeSinceFailure;
        return Result.err(
          new CircuitOpenError({
            message: `Circuit breaker is open. Retry after ${retryAfterMs}ms`,
            retryAfterMs,
          })
        );
      }
    }

    // Execute the function
    try {
      const value = await fn();
      this.onSuccess();
      return Result.ok(value);
    } catch (error) {
      this.onFailure();
      return Result.err(errorWrapper(error));
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.options.halfOpenSuccessThreshold) {
        // Enough successes, close the circuit
        this.state = "closed";
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Any failure in half-open state opens the circuit
      this.state = "open";
    } else if (this.failureCount >= this.options.failureThreshold) {
      // Threshold reached, open the circuit
      this.state = "open";
    }
  }
}
