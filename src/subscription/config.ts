import type { Env } from '../types';
import type { SubscriptionConfig, SubscriptionTarget } from './types';

const DEFAULT_SUBSCRIPTION_ENABLED = false;
const DEFAULT_SUBSCRIPTION_PRESERVE_DOMAIN = false;
const DEFAULT_SUBSCRIPTION_TRANSFORM = false;
const DEFAULT_SUBSCRIPTION_CACHE_TTL_MS = 5 * 60_000;
const MAX_PORT = 65_535;

type JsonTargetInput = Partial<SubscriptionTarget> & Record<string, unknown>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return fallback;
}

function parsePort(rawPort: string | number | undefined): number | null {
  const numericPort = typeof rawPort === 'number' ? rawPort : Number(rawPort);

  if (!Number.isFinite(numericPort) || !Number.isInteger(numericPort)) {
    return null;
  }

  if (numericPort < 1 || numericPort > MAX_PORT) {
    return null;
  }

  return numericPort;
}

function normalizePath(rawPath: string | undefined): string {
  const value = (rawPath ?? '').trim();

  if (!value) {
    return '/sub';
  }

  if (value.startsWith('/')) {
    return value;
  }

  return `/${value}`;
}

function parseBaseUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function toSubscriptionTarget(
  name: string,
  rawUrl: string,
  rawPort: string | number | undefined,
  rawPath: string | undefined,
): SubscriptionTarget | null {
  const normalizedName = name.trim().toLowerCase();
  const parsedUrl = parseBaseUrl(rawUrl);

  if (!normalizedName || !parsedUrl) {
    return null;
  }

  const parsedPort = parsePort(rawPort) ?? parsePort(parsedUrl.port) ?? (parsedUrl.protocol === 'https:' ? 443 : 80);
  if (!parsedPort) {
    return null;
  }

  // Persist only origin-level URL; path is controlled by target.path and requested token.
  parsedUrl.pathname = '/';
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return {
    name: normalizedName,
    url: parsedUrl.toString(),
    port: parsedPort,
    path: normalizePath(rawPath),
  };
}

function parseTargetsFromJson(rawTargets: string): SubscriptionTarget[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawTargets);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const targets: SubscriptionTarget[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const input = entry as JsonTargetInput;
    const name = typeof input.name === 'string' ? input.name : '';
    const url = typeof input.url === 'string' ? input.url : '';
    const path = typeof input.path === 'string' ? input.path : undefined;
    const port = typeof input.port === 'number' || typeof input.port === 'string' ? input.port : undefined;
    const target = toSubscriptionTarget(name, url, port, path);

    if (target) {
      targets.push(target);
    }
  }

  return targets;
}

function parseTargetsFromDelimited(rawTargets: string): SubscriptionTarget[] {
  const entries = rawTargets
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const targets: SubscriptionTarget[] = [];

  for (const entry of entries) {
    const [name = '', url = '', port = '', path = ''] = entry.split('|', 4).map((part) => part.trim());
    const target = toSubscriptionTarget(name, url, port, path);

    if (target) {
      targets.push(target);
    }
  }

  return targets;
}

function dedupeTargets(targets: SubscriptionTarget[]): SubscriptionTarget[] {
  const deduped = new Map<string, SubscriptionTarget>();

  for (const target of targets) {
    if (!deduped.has(target.name)) {
      deduped.set(target.name, target);
    }
  }

  return Array.from(deduped.values());
}

/**
 * Parses subscription targets from JSON or `name|url|port|path` comma-separated format.
 */
export function parseSubscriptionTargets(rawTargets: string | undefined): SubscriptionTarget[] {
  const normalized = (rawTargets ?? '').trim();

  if (!normalized) {
    return [];
  }

  const fromJson = parseTargetsFromJson(normalized);
  if (fromJson.length > 0) {
    return dedupeTargets(fromJson);
  }

  return dedupeTargets(parseTargetsFromDelimited(normalized));
}

/**
 * Resolves subscription feature configuration from environment variables.
 * `preserveDomain` is only active when subscription mode is enabled.
 */
export function resolveSubscriptionConfig(env: Env): SubscriptionConfig {
  const enabled = parseBoolean(env.SUBSCRIPTION_ENABLED, DEFAULT_SUBSCRIPTION_ENABLED);

  if (!enabled) {
    return {
      enabled: false,
      preserveDomain: false,
      targets: [],
    };
  }

  return {
    enabled: true,
    preserveDomain: parseBoolean(env.SUBSCRIPTION_PRESERVE_DOMAIN, DEFAULT_SUBSCRIPTION_PRESERVE_DOMAIN),
    targets: parseSubscriptionTargets(env.SUBSCRIPTION_TARGETS),
  };
}

/**
 * Resolves optional subscription link transformation flag.
 */
export function resolveSubscriptionTransform(env: Env): boolean {
  return parseBoolean(env.SUBSCRIPTION_TRANSFORM, DEFAULT_SUBSCRIPTION_TRANSFORM);
}

/**
 * Resolves subscription cache TTL in milliseconds.
 */
export function resolveSubscriptionCacheTtlMs(env: Env): number {
  const parsed = Number(env.SUBSCRIPTION_CACHE_TTL_MS);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_SUBSCRIPTION_CACHE_TTL_MS;
  }

  return parsed;
}
