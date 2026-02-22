import type { Env } from '../types';
import { SubscriptionCache } from './cache';
import type { SubscriptionConfig } from './types';
import {
  DEFAULT_SUBSCRIPTION_SERVICE,
  proxySubscriptionRequest,
  type SubscriptionRoute,
  parseSubscriptionRoute,
} from './proxy';
import {
  resolveSubscriptionCacheTtlMs,
  resolveSubscriptionConfig,
  resolveSubscriptionTransform,
} from './config';

const MAX_SUBSCRIPTION_CACHES = 16;

const SUBSCRIPTION_CACHES = new Map<number, SubscriptionCache>();

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function getCache(ttlMs: number): SubscriptionCache {
  const normalizedTtlMs = Math.max(1_000, ttlMs);
  const cached = SUBSCRIPTION_CACHES.get(normalizedTtlMs);
  if (cached) {
    return cached;
  }

  if (SUBSCRIPTION_CACHES.size >= MAX_SUBSCRIPTION_CACHES) {
    SUBSCRIPTION_CACHES.clear();
  }

  const created = new SubscriptionCache(normalizedTtlMs);
  SUBSCRIPTION_CACHES.set(normalizedTtlMs, created);
  return created;
}

function canTransformResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/plain') || contentType.includes('application/json');
}

function transformSubscriptionPayload(body: string, requestUrl: URL): string {
  const host = `${requestUrl.protocol}//${requestUrl.host}`;
  return body.replaceAll(/https?:\/\/[^\s"'<>]+/g, (matched) => {
    try {
      const parsed = new URL(matched);
      const source = `${parsed.protocol}//${parsed.host}`;

      if (source === host) {
        return matched;
      }

      return `${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return matched;
    }
  });
}

async function maybeTransformSubscriptionResponse(
  response: Response,
  requestUrl: URL,
  enabled: boolean,
): Promise<Response> {
  if (!enabled || response.status !== 200 || !canTransformResponse(response)) {
    return response;
  }

  try {
    const bodyText = await response.text();
    const transformed = transformSubscriptionPayload(bodyText, requestUrl);
    const headers = new Headers(response.headers);
    headers.set('content-length', String(new TextEncoder().encode(transformed).byteLength));
    return new Response(transformed, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

/**
 * Renders plain-text landing info when subscription mode is enabled.
 */
export function renderSubscriptionInfoPage(env: Env, preResolvedConfig?: SubscriptionConfig): Response {
  const config = preResolvedConfig ?? resolveSubscriptionConfig(env);

  if (!config.enabled) {
    return textResponse(404, 'Subscription mode is disabled.');
  }

  const lines: string[] = [
    'cf-xray-proxy subscription mode',
    `targets: ${config.targets.length}`,
    '',
    'routes:',
    '/sub/:token',
    '/:service/sub/:token',
  ];

  for (const target of config.targets) {
    lines.push(`- ${target.name}: ${target.url}:${target.port}${target.path}`);
  }

  return textResponse(200, lines.join('\n'));
}

/**
 * Handles subscription routes when feature is enabled.
 */
export async function handleSubscriptionRequest(
  request: Request,
  env: Env,
  preResolvedConfig?: SubscriptionConfig,
  preParsedRoute?: SubscriptionRoute,
): Promise<Response> {
  const config = preResolvedConfig ?? resolveSubscriptionConfig(env);
  if (!config.enabled) {
    return textResponse(404, 'Not found.');
  }

  if (request.method.toUpperCase() !== 'GET') {
    return textResponse(405, 'Method not allowed.');
  }

  const route = preParsedRoute ?? parseSubscriptionRoute(new URL(request.url).pathname);
  if (!route) {
    return textResponse(404, 'Not found.');
  }

  const transformEnabled = resolveSubscriptionTransform(env);
  const cache = getCache(resolveSubscriptionCacheTtlMs(env));
  const cacheService = route.service || DEFAULT_SUBSCRIPTION_SERVICE;

  const cached = cache.get(cacheService, route.token);
  if (cached) {
    return maybeTransformSubscriptionResponse(cached, new URL(request.url), transformEnabled);
  }

  const proxied = await proxySubscriptionRequest(request, route, config.targets, {
    preserveDomain: config.preserveDomain,
  });
  const response = await maybeTransformSubscriptionResponse(
    proxied.response,
    new URL(request.url),
    transformEnabled,
  );

  if (response.status === 200) {
    cache.set(cacheService, route.token, response);
  }

  return response;
}
