import { UUID_MAX_CONNECTIONS } from './config';
import type { Env } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UUID_REPLACED_CLOSE_CODE = 1008;
const UUID_REPLACED_CLOSE_REASON = 'Connection replaced by a newer session.';
const UUID_CLEANUP_INTERVAL_MS = 60_000;
const UUID_ENTRY_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const UUID_IDLE_BUCKET_TTL_MS = 10 * 60_000;
const UUID_MAX_TRACKED_BUCKETS = 10_000;
const UUID_STALE_CLOSE_CODE = 1001;
const UUID_STALE_CLOSE_REASON = 'Stale connection cleanup.';

export type UUIDDisconnectFn = (code: number, reason: string) => void;

interface UUIDTrackedConnection {
  connectionId: string;
  ip: string;
  timestamp: number;
  disconnect?: UUIDDisconnectFn;
}

interface UUIDBucket {
  byConnectionId: Map<string, UUIDTrackedConnection>;
  byIp: Map<string, Set<string>>;
  lastTouchedAt: number;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : 'unknown';
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

function normalizeUuid(value: string): string {
  return value.trim().toLowerCase();
}

function extractUuidFromPath(url: URL): string | null {
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0).map(decodePathSegment);

  const first = segments[0];
  if (first && isValidUuid(first)) {
    return normalizeUuid(first);
  }

  const second = segments[1];
  if (first?.toLowerCase() === 'sub' && second && isValidUuid(second)) {
    return normalizeUuid(second);
  }

  return null;
}

/**
 * Resolves UUID connection cap from env/config. 0 means disabled.
 */
export function resolveUuidMaxConnections(env: Env): number {
  return parseNonNegativeInteger(env.UUID_MAX_CONNECTIONS, UUID_MAX_CONNECTIONS);
}

/**
 * Extracts UUID from supported request formats:
 * `/uuid/...`, `/sub/uuid/...`, and `?id=uuid`.
 */
export function extractUuidFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('id');

  if (fromQuery && isValidUuid(fromQuery)) {
    return normalizeUuid(fromQuery);
  }

  return extractUuidFromPath(url);
}

/**
 * UUID connection limiter with O(1) lookup/insert/delete paths via two-level indexes:
 * - UUID -> bucket
 * - bucket: IP -> Set<connectionId>, connectionId -> metadata
 *
 * This is a two-level hash-index design optimized for constant-time membership checks
 * and constant-time same-IP replacement operations.
 */
export class UUIDConnectionManager {
  private readonly maxConnections: number;
  private readonly debugEnabled: boolean;

  private readonly bucketsByUuid = new Map<string, UUIDBucket>();
  private readonly uuidByConnectionId = new Map<string, string>();
  private nextCleanupAt = 0;

  constructor(maxConnections: number, debugEnabled: boolean) {
    this.maxConnections = Math.max(0, maxConnections);
    this.debugEnabled = debugEnabled;
    this.nextCleanupAt = Date.now() + UUID_CLEANUP_INTERVAL_MS;
  }

  public isEnabled(): boolean {
    return this.maxConnections > 0;
  }

  /**
   * Returns true if a new connection is allowed for UUID/IP pair.
   * Same-IP reconnect is always allowed (existing one will be replaced).
   */
  public checkConnectionAllowed(uuid: string, ip: string): boolean {
    if (!this.isEnabled()) {
      return true;
    }

    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedUuid = normalizeUuid(uuid);
    const normalizedIp = normalizeIp(ip);
    const bucket = this.bucketsByUuid.get(normalizedUuid);

    if (!bucket) {
      return true;
    }

    bucket.lastTouchedAt = now;

    if (bucket.byConnectionId.size < this.maxConnections) {
      return true;
    }

    if (bucket.byIp.has(normalizedIp)) {
      return true;
    }

    if (this.debugEnabled) {
      console.warn('[uuid] rejecting connection', {
        uuid: normalizedUuid,
        ip: normalizedIp,
        activeConnections: bucket.byConnectionId.size,
        maxConnections: this.maxConnections,
      });
    }

    return false;
  }

  /**
   * Registers a UUID connection and replaces existing same-IP sessions.
   */
  public registerConnection(
    uuid: string,
    ip: string,
    connectionId: string,
    disconnect?: UUIDDisconnectFn,
  ): void {
    if (!this.isEnabled()) {
      return;
    }

    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedUuid = normalizeUuid(uuid);
    const normalizedIp = normalizeIp(ip);
    const bucket = this.getOrCreateBucket(normalizedUuid, now);

    const sameIpConnections = bucket.byIp.get(normalizedIp);
    if (sameIpConnections && sameIpConnections.size > 0) {
      for (const existingConnectionId of Array.from(sameIpConnections)) {
        this.removeConnection(
          normalizedUuid,
          bucket,
          existingConnectionId,
          true,
          UUID_REPLACED_CLOSE_CODE,
          UUID_REPLACED_CLOSE_REASON,
          true,
        );
      }
    }

    if (bucket.byConnectionId.size >= this.maxConnections && !bucket.byIp.has(normalizedIp)) {
      if (this.debugEnabled) {
        console.warn('[uuid] register skipped due to full bucket', {
          uuid: normalizedUuid,
          ip: normalizedIp,
          connectionId,
          activeConnections: bucket.byConnectionId.size,
          maxConnections: this.maxConnections,
        });
      }
      return;
    }

    const existingUuid = this.uuidByConnectionId.get(connectionId);
    if (existingUuid) {
      const existingBucket = this.bucketsByUuid.get(existingUuid);
      if (existingBucket) {
        this.removeConnection(existingUuid, existingBucket, connectionId, false);
      } else {
        this.uuidByConnectionId.delete(connectionId);
      }
    }

    const tracked: UUIDTrackedConnection = {
      connectionId,
      ip: normalizedIp,
      timestamp: now,
    };

    if (disconnect) {
      tracked.disconnect = disconnect;
    }

    bucket.byConnectionId.set(connectionId, tracked);

    let ipSet = bucket.byIp.get(normalizedIp);
    if (!ipSet) {
      ipSet = new Set<string>();
      bucket.byIp.set(normalizedIp, ipSet);
    }

    ipSet.add(connectionId);
    bucket.lastTouchedAt = now;
    this.uuidByConnectionId.set(connectionId, normalizedUuid);

    this.evictIdleBucketsIfNeeded(now);
  }

  /**
   * Unregisters an active UUID connection entry.
   */
  public unregisterConnection(uuid: string, connectionId: string): void {
    if (!this.isEnabled()) {
      return;
    }

    const now = Date.now();
    this.maybeCleanup(now);

    const normalizedUuid = normalizeUuid(uuid);
    const bucket = this.bucketsByUuid.get(normalizedUuid);

    if (!bucket) {
      this.uuidByConnectionId.delete(connectionId);
      return;
    }

    this.removeConnection(normalizedUuid, bucket, connectionId, false);
    bucket.lastTouchedAt = now;

    if (bucket.byConnectionId.size === 0) {
      this.bucketsByUuid.delete(normalizedUuid);
    }
  }

  private getOrCreateBucket(uuid: string, now: number): UUIDBucket {
    const existing = this.bucketsByUuid.get(uuid);
    if (existing) {
      existing.lastTouchedAt = now;
      return existing;
    }

    const created: UUIDBucket = {
      byConnectionId: new Map<string, UUIDTrackedConnection>(),
      byIp: new Map<string, Set<string>>(),
      lastTouchedAt: now,
    };

    this.bucketsByUuid.set(uuid, created);
    return created;
  }

  private removeConnection(
    uuid: string,
    bucket: UUIDBucket,
    connectionId: string,
    invokeDisconnect: boolean,
    closeCode = UUID_REPLACED_CLOSE_CODE,
    closeReason = UUID_REPLACED_CLOSE_REASON,
    keepBucketWhenEmpty = false,
  ): void {
    const connection = bucket.byConnectionId.get(connectionId);
    if (!connection) {
      this.uuidByConnectionId.delete(connectionId);
      return;
    }

    bucket.byConnectionId.delete(connectionId);
    this.uuidByConnectionId.delete(connectionId);

    const ipConnections = bucket.byIp.get(connection.ip);
    if (ipConnections) {
      ipConnections.delete(connectionId);
      if (ipConnections.size === 0) {
        bucket.byIp.delete(connection.ip);
      }
    }

    if (invokeDisconnect) {
      try {
        connection.disconnect?.(closeCode, closeReason);
      } catch {
        // Ignore disconnect callback failures.
      }
    }

    if (!keepBucketWhenEmpty && bucket.byConnectionId.size === 0) {
      this.bucketsByUuid.delete(uuid);
    }
  }

  private maybeCleanup(now: number): void {
    if (now < this.nextCleanupAt) {
      return;
    }

    this.cleanup(now);
  }

  private cleanup(now: number): void {
    for (const [uuid, bucket] of this.bucketsByUuid) {
      const staleConnectionIds: string[] = [];

      for (const [connectionId, connection] of bucket.byConnectionId) {
        const ageMs = now - connection.timestamp;

        if (ageMs < UUID_ENTRY_STALE_MS) {
          continue;
        }

        staleConnectionIds.push(connectionId);
      }

      for (const connectionId of staleConnectionIds) {
        this.removeConnection(uuid, bucket, connectionId, true, UUID_STALE_CLOSE_CODE, UUID_STALE_CLOSE_REASON);
      }

      if (bucket.byConnectionId.size > 0) {
        continue;
      }

      if (now - bucket.lastTouchedAt >= UUID_IDLE_BUCKET_TTL_MS) {
        this.bucketsByUuid.delete(uuid);
      }
    }

    this.evictIdleBucketsIfNeeded(now);
    this.nextCleanupAt = now + UUID_CLEANUP_INTERVAL_MS;
  }

  private evictIdleBucketsIfNeeded(now: number): void {
    if (this.bucketsByUuid.size <= UUID_MAX_TRACKED_BUCKETS) {
      return;
    }

    const idleCandidates: Array<{ uuid: string; lastTouchedAt: number }> = [];

    for (const [uuid, bucket] of this.bucketsByUuid) {
      if (bucket.byConnectionId.size > 0) {
        continue;
      }

      idleCandidates.push({
        uuid,
        lastTouchedAt: bucket.lastTouchedAt,
      });
    }

    if (idleCandidates.length === 0) {
      return;
    }

    idleCandidates.sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);

    for (const candidate of idleCandidates) {
      if (this.bucketsByUuid.size <= UUID_MAX_TRACKED_BUCKETS) {
        break;
      }

      if (now - candidate.lastTouchedAt < UUID_IDLE_BUCKET_TTL_MS) {
        continue;
      }

      this.bucketsByUuid.delete(candidate.uuid);
    }
  }
}
