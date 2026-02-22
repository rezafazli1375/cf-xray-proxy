import { MAX_RETRIES } from '../config';

export const BACKEND_UPGRADE_TIMEOUT_MS = 5_000;
export const BACKEND_PASSTHROUGH_TIMEOUT_MS = 15_000;
const BASE_RETRY_DELAY_MS = 150;
const MAX_RETRY_DELAY_MS = 2_000;

/**
 * Normalizes retry values from config/env to a non-negative integer.
 */
export function normalizeRetryCount(maxRetries: number, fallback = MAX_RETRIES): number {
  if (!Number.isFinite(maxRetries)) {
    return fallback;
  }

  return Math.max(0, Math.floor(maxRetries));
}

/**
 * Returns an exponential backoff delay with jitter to avoid retry bursts.
 */
export function getRetryBackoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const exponentialDelayMs = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** exponent);
  const jitterSpreadMs = Math.max(1, Math.floor(exponentialDelayMs * 0.3));
  const jitterMs = Math.floor(Math.random() * jitterSpreadMs);
  return exponentialDelayMs + jitterMs;
}

/**
 * Sleeps for one retry interval derived from attempt index.
 */
export async function waitForRetry(attempt: number): Promise<void> {
  const delayMs = getRetryBackoffDelayMs(attempt);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Executes fetch with per-attempt timeout and exponential backoff retries.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  const retryCount = normalizeRetryCount(maxRetries);
  let lastError: unknown = new Error('fetchWithTimeout failed without a captured error.');

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;

      if (attempt >= retryCount) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }

    await waitForRetry(attempt);
  }

  throw lastError instanceof Error ? lastError : new Error('Backend request failed.');
}

/**
 * Returns true when an error was raised by AbortController cancellation.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError';
}
