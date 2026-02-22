const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024;
const DEFAULT_ENTRY_SIZE_BYTES = 4 * 1024;
const CLEANUP_INTERVAL_MS = 30_000;

interface SubscriptionCacheEntry {
  expiresAt: number;
  response: Response;
  sizeBytes: number;
}

interface CacheNode {
  key: string;
  entry: SubscriptionCacheEntry;
  prev: CacheNode | null;
  next: CacheNode | null;
}

function buildCacheKey(service: string, token: string): string {
  return `${service.toLowerCase()}:${token}`;
}

function parseContentLength(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const parsed = Number(headerValue);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function estimateResponseSize(response: Response): number {
  const fromHeader = parseContentLength(response.headers.get('content-length'));

  if (fromHeader !== null) {
    return fromHeader;
  }

  return DEFAULT_ENTRY_SIZE_BYTES;
}

/**
 * TTL + size-bounded LRU cache.
 *
 * Data structure:
 * - Hash map for O(1) key lookup
 * - Doubly linked list for O(1) recency updates and tail eviction
 *
 * This follows the canonical hashmap + doubly-linked-list LRU strategy used in
 * systems caches for predictable O(1) lookup/update/eviction.
 */
export class SubscriptionCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  private readonly nodesByKey = new Map<string, CacheNode>();
  private head: CacheNode | null = null;
  private tail: CacheNode | null = null;

  private totalBytes = 0;
  private nextCleanupAt = 0;

  constructor(ttlMs = DEFAULT_CACHE_TTL_MS, maxEntries = DEFAULT_MAX_CACHE_ENTRIES, maxBytes = DEFAULT_MAX_CACHE_BYTES) {
    this.ttlMs = Math.max(1_000, ttlMs);
    this.maxEntries = Math.max(1, maxEntries);
    this.maxBytes = Math.max(DEFAULT_ENTRY_SIZE_BYTES, maxBytes);
    this.nextCleanupAt = Date.now() + Math.min(this.ttlMs, CLEANUP_INTERVAL_MS);
  }

  /**
   * Returns a cached response clone for a given service/token key.
   * Amortized O(1).
   */
  public get(service: string, token: string): Response | null {
    const now = Date.now();
    this.maybeCleanup(now);

    const key = buildCacheKey(service, token);
    const node = this.nodesByKey.get(key);

    if (!node) {
      return null;
    }

    if (node.entry.expiresAt <= now) {
      this.removeNode(node);
      return null;
    }

    this.moveToHead(node);
    return node.entry.response.clone();
  }

  /**
   * Stores only HTTP 200 responses in cache.
   * O(1) insertion + O(k) evictions where k is number of evicted entries.
   */
  public set(service: string, token: string, response: Response): void {
    if (response.status !== 200) {
      return;
    }

    const now = Date.now();
    this.maybeCleanup(now);

    const key = buildCacheKey(service, token);
    const sizeBytes = estimateResponseSize(response);

    if (sizeBytes > this.maxBytes) {
      const existing = this.nodesByKey.get(key);
      if (existing) {
        this.removeNode(existing);
      }
      return;
    }

    const existing = this.nodesByKey.get(key);
    if (existing) {
      this.removeNode(existing);
    }

    const node: CacheNode = {
      key,
      entry: {
        expiresAt: now + this.ttlMs,
        response: response.clone(),
        sizeBytes,
      },
      prev: null,
      next: null,
    };

    this.insertAtHead(node);
    this.nodesByKey.set(key, node);
    this.totalBytes += sizeBytes;

    this.evictIfNeeded();
  }

  /**
   * Removes expired cache entries and enforces memory bounds.
   */
  public cleanup(): void {
    const now = Date.now();

    let current = this.tail;
    while (current) {
      const previous = current.prev;

      if (current.entry.expiresAt <= now) {
        this.removeNode(current);
      }

      current = previous;
    }

    this.evictIfNeeded();
    this.nextCleanupAt = now + Math.min(this.ttlMs, CLEANUP_INTERVAL_MS);
  }

  private maybeCleanup(now: number): void {
    if (now < this.nextCleanupAt) {
      return;
    }

    this.cleanup();
  }

  private evictIfNeeded(): void {
    while (this.nodesByKey.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const node = this.tail;

      if (!node) {
        break;
      }

      this.removeNode(node);
    }
  }

  private insertAtHead(node: CacheNode): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  private moveToHead(node: CacheNode): void {
    if (this.head === node) {
      return;
    }

    this.detach(node);
    this.insertAtHead(node);
  }

  private removeNode(node: CacheNode): void {
    this.detach(node);
    this.nodesByKey.delete(node.key);
    this.totalBytes = Math.max(0, this.totalBytes - node.entry.sizeBytes);
  }

  private detach(node: CacheNode): void {
    const previous = node.prev;
    const next = node.next;

    if (previous) {
      previous.next = next;
    } else {
      this.head = next;
    }

    if (next) {
      next.prev = previous;
    } else {
      this.tail = previous;
    }

    node.prev = null;
    node.next = null;
  }
}
