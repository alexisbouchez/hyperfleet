import { Result } from "better-result";
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from "./types.js";

/**
 * Calculates delay with exponential backoff and optional jitter.
 */
function calculateDelay(
  attempt: number,
  options: RetryOptions
): number {
  const exponentialDelay =
    options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);

  if (options.jitter) {
    // Add random jitter between 0% and 50% of the delay
    const jitterFactor = 0.5 * Math.random();
    return Math.floor(cappedDelay * (1 + jitterFactor));
  }

  return cappedDelay;
}

/**
 * Default retry predicate - retries on any error
 */
function defaultRetryOn(): boolean {
  return true;
}

/**
 * Executes a function with retry logic using exponential backoff.
 *
 * @param fn - Async function returning a Result
 * @param options - Retry configuration options
 * @returns Result from the last attempt
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => client.fetchData(),
 *   { maxAttempts: 3, initialDelayMs: 100 }
 * );
 * ```
 */
export async function withRetry<T, E>(
  fn: () => Promise<Result<T, E>>,
  options: Partial<RetryOptions> = {}
): Promise<Result<T, E>> {
  const config: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const retryOn = config.retryOn ?? defaultRetryOn;

  let lastResult: Result<T, E> | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    lastResult = await fn();

    if (lastResult.isOk()) {
      return lastResult;
    }

    // Check if we should retry this error
    if (!retryOn(lastResult.error)) {
      return lastResult;
    }

    // Don't delay after the last attempt
    if (attempt < config.maxAttempts) {
      const delay = calculateDelay(attempt, config);
      await Bun.sleep(delay);
    }
  }

  // Return the last result (which is an error)
  return lastResult!;
}

/**
 * Executes a function with retry logic, wrapping thrown errors.
 * Use this for functions that throw instead of returning Result.
 *
 * @param fn - Async function that may throw
 * @param errorWrapper - Function to wrap caught errors
 * @param options - Retry configuration options
 * @returns Result with success value or wrapped error
 *
 * @example
 * ```ts
 * const result = await withRetryThrows(
 *   () => fetch(url).then(r => r.json()),
 *   (e) => new NetworkError({ message: String(e) }),
 *   { maxAttempts: 3 }
 * );
 * ```
 */
export async function withRetryThrows<T, E>(
  fn: () => Promise<T>,
  errorWrapper: (error: unknown) => E,
  options: Partial<RetryOptions> = {}
): Promise<Result<T, E>> {
  const config: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const retryOn = config.retryOn ?? defaultRetryOn;

  let lastError: E | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const value = await fn();
      return Result.ok(value);
    } catch (error) {
      lastError = errorWrapper(error);

      // Check if we should retry this error
      if (!retryOn(error)) {
        return Result.err(lastError);
      }

      // Don't delay after the last attempt
      if (attempt < config.maxAttempts) {
        const delay = calculateDelay(attempt, config);
        await Bun.sleep(delay);
      }
    }
  }

  return Result.err(lastError!);
}
