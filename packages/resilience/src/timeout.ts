import { Result } from "better-result";
import { TimeoutError } from "@hyperfleet/errors";

/**
 * Wraps a promise with a timeout, returning a Result type.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param message - Optional custom error message
 * @returns Result with the resolved value or TimeoutError
 *
 * @example
 * ```ts
 * const result = await withTimeout(fetch(url), 5000);
 * if (result.isErr()) {
 *   console.error("Request timed out:", result.error.message);
 * }
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string
): Promise<Result<T, TimeoutError>> {
  return Result.tryPromise({
    try: async () => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new TimeoutError({
              message: message ?? `Operation timed out after ${timeoutMs}ms`,
            })
          );
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([promise, timeoutPromise]);
        return result;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    },
    catch: (error) => {
      if (TimeoutError.is(error)) {
        return error;
      }
      return new TimeoutError({
        message: message ?? `Operation timed out after ${timeoutMs}ms`,
      });
    },
  });
}

/**
 * Creates a promise that rejects after the specified timeout.
 * Useful for racing against other promises.
 *
 * @param timeoutMs - Timeout in milliseconds
 * @param message - Optional custom error message
 * @returns A promise that rejects with TimeoutError
 */
export function createTimeoutPromise(
  timeoutMs: number,
  message?: string
): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new TimeoutError({
          message: message ?? `Operation timed out after ${timeoutMs}ms`,
        })
      );
    }, timeoutMs);
  });
}
