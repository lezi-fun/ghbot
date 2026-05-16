import { logger } from "./logger.js";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;

export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  }
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      logger.warn(
        {
          error,
          label,
          attempt,
          maxAttempts
        },
        "Request failed."
      );

      if (attempt === maxAttempts) {
        break;
      }

      await delay(baseDelayMs * attempt);
    }
  }

  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
