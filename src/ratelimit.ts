import {
  RATE_LIMIT_ENABLED as DEFAULT_RATE_LIMIT_ENABLED,
  RATE_LIMIT_MAX_CONN_PER_IP,
  RATE_LIMIT_MAX_CONN_PER_MIN,
} from './config';
import type { Env } from './types';

const ONE_MINUTE_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const IDLE_STATE_TTL_MS = ONE_MINUTE_MS;
const CONCURRENT_LIMIT_RETRY_AFTER_SECONDS = 10;
const UNKNOWN_IP = 'unknown';
const TOKEN_EPSILON = 1e-9;

export interface RateLimitConfig {
  enabled: boolean;
  maxConnPerIp: number;
  maxConnPerMin: number;
}

interface IpTokenBucketState {
  activeConnectionIds: Set<string>;
  tokens: number;
  lastRefillAt: number;
  lastSeenAt: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.length > 0 ? trimmed : UNKNOWN_IP;
}

/**
 * Parses rate-limit configuration from env with defaults.
 */
export function resolveRateLimitConfig(env: Env): RateLimitConfig {
  const enabledRaw = (env.RATE_LIMIT_ENABLED ?? String(DEFAULT_RATE_LIMIT_ENABLED)).trim().toLowerCase();
  const enabled = enabledRaw === 'true';

  return {
    enabled,
    maxConnPerIp: parsePositiveInteger(env.RATE_LIMIT_MAX_CONN_PER_IP, RATE_LIMIT_MAX_CONN_PER_IP),
    maxConnPerMin: parsePositiveInteger(env.RATE_LIMIT_MAX_CONN_PER_MIN, RATE_LIMIT_MAX_CONN_PER_MIN),
  };
}

/**
 * Token-bucket connection limiter:
 * - concurrent gate (max active per IP)
 * - rate gate (max new connections/minute)
 *
 * References:
 * - Token bucket policing model used in network QoS literature
 * - RFC 2697 (Single Rate Three Color Marker) for refill/consumption semantics
 *
 * Complexity:
 * - check/update paths: O(1)
 * - cleanup: O(number of tracked IPs), executed lazily on interval boundaries
 */
export class ConnectionRateLimiter {
  private readonly maxConnPerIp: number;
  private readonly maxConnPerMin: number;
  private readonly bucketCapacity: number;
  private readonly refillTokensPerMs: number;

  private readonly stateByIp = new Map<string, IpTokenBucketState>();
  private nextCleanupAt = 0;

  constructor(maxConnPerIp: number, maxConnPerMin: number) {
    this.maxConnPerIp = Math.max(1, maxConnPerIp);
    this.maxConnPerMin = Math.max(1, maxConnPerMin);
    this.bucketCapacity = this.maxConnPerMin;
    this.refillTokensPerMs = this.maxConnPerMin / ONE_MINUTE_MS;
    this.nextCleanupAt = Date.now() + CLEANUP_INTERVAL_MS;
  }

  /**
   * Returns true when a new connection is allowed for the given IP.
   */
  public checkConnectionAllowed(ip: string): boolean {
    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedIp = normalizeIp(ip);
    const state = this.getOrCreateState(normalizedIp, now);
    this.refillTokens(state, now);
    state.lastSeenAt = now;

    if (state.activeConnectionIds.size >= this.maxConnPerIp) {
      return false;
    }

    return state.tokens + TOKEN_EPSILON >= 1;
  }

  /**
   * Tracks a newly accepted connection for the given IP.
   */
  public registerConnection(ip: string, connId: string): void {
    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedIp = normalizeIp(ip);
    const state = this.getOrCreateState(normalizedIp, now);
    this.refillTokens(state, now);

    if (state.activeConnectionIds.has(connId)) {
      state.lastSeenAt = now;
      return;
    }

    // Track accepted connections even under interleaving requests.
    // Caller gates admission via checkConnectionAllowed before registerConnection.
    state.activeConnectionIds.add(connId);
    if (state.tokens + TOKEN_EPSILON >= 1) {
      state.tokens = Math.max(0, state.tokens - 1);
    } else {
      state.tokens = 0;
    }
    state.lastSeenAt = now;
  }

  /**
   * Removes an active connection entry after a socket closes.
   */
  public unregisterConnection(ip: string, connId: string): void {
    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedIp = normalizeIp(ip);
    const state = this.stateByIp.get(normalizedIp);

    if (!state) {
      return;
    }

    if (state.activeConnectionIds.delete(connId)) {
      state.lastSeenAt = now;
    }

    this.deleteIfIdle(normalizedIp, state, now);
  }

  /**
   * Removes stale per-IP state older than one minute when idle.
   */
  public cleanupOldAttempts(): void {
    const now = Date.now();

    for (const [ip, state] of this.stateByIp) {
      this.refillTokens(state, now);
      this.deleteIfIdle(ip, state, now);
    }

    this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
  }

  /**
   * Returns Retry-After seconds for blocked IP addresses.
   */
  public getRetryAfterSeconds(ip: string): number {
    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedIp = normalizeIp(ip);
    const state = this.stateByIp.get(normalizedIp);
    if (!state) {
      return 1;
    }

    this.refillTokens(state, now);

    if (state.activeConnectionIds.size >= this.maxConnPerIp) {
      return CONCURRENT_LIMIT_RETRY_AFTER_SECONDS;
    }

    if (state.tokens + TOKEN_EPSILON >= 1) {
      return 1;
    }

    const missingTokens = Math.max(0, 1 - state.tokens);
    const refillMs = this.refillTokensPerMs > 0 ? missingTokens / this.refillTokensPerMs : ONE_MINUTE_MS;
    const boundedMs = Math.max(1_000, refillMs);

    return Math.max(1, Math.ceil(boundedMs / 1_000));
  }

  private maybeCleanup(now: number): void {
    if (now < this.nextCleanupAt) {
      return;
    }

    this.cleanupOldAttempts();
  }

  private getOrCreateState(ip: string, now: number): IpTokenBucketState {
    const existing = this.stateByIp.get(ip);
    if (existing) {
      return existing;
    }

    const created: IpTokenBucketState = {
      activeConnectionIds: new Set<string>(),
      tokens: this.bucketCapacity,
      lastRefillAt: now,
      lastSeenAt: now,
    };

    this.stateByIp.set(ip, created);
    return created;
  }

  private refillTokens(state: IpTokenBucketState, now: number): void {
    if (now <= state.lastRefillAt) {
      return;
    }

    const elapsedMs = now - state.lastRefillAt;
    const replenished = elapsedMs * this.refillTokensPerMs;
    state.tokens = Math.min(this.bucketCapacity, state.tokens + replenished);
    state.lastRefillAt = now;
  }

  private deleteIfIdle(ip: string, state: IpTokenBucketState, now: number): void {
    if (state.activeConnectionIds.size > 0) {
      return;
    }

    const isRefilled = state.tokens >= this.bucketCapacity - TOKEN_EPSILON;
    const isExpired = now - state.lastSeenAt >= IDLE_STATE_TTL_MS;

    if (isRefilled && isExpired) {
      this.stateByIp.delete(ip);
    }
  }
}
