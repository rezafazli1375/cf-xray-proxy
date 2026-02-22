import { buildDomainPreservationContext, preserveSubscriptionDomain } from './transform';
import type { SubscriptionTarget } from './types';

/** Canonical service key used by `/sub/:token` routes. */
export const DEFAULT_SUBSCRIPTION_SERVICE = 'default';
const SUBSCRIPTION_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_SIZE_ERROR_CODE = 'SUBSCRIPTION_SIZE_LIMIT_EXCEEDED';
const INITIAL_READ_BUFFER_BYTES = 16 * 1024;

export interface SubscriptionRoute {
  service: string;
  token: string;
}

export interface SubscriptionProxyResult {
  service: string;
  token: string;
  response: Response;
}

export interface SubscriptionProxyOptions {
  preserveDomain?: boolean;
}

function normalizeServiceName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : DEFAULT_SUBSCRIPTION_SERVICE;
}

function normalizeToken(value: string): string {
  return value.trim();
}

function isValidServiceSegment(segment: string): boolean {
  return segment.length > 0 && !segment.includes('/');
}

function isValidToken(value: string): boolean {
  return value.length > 0;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Extracts subscription route data from `/sub/:token` or `/:service/sub/:token`.
 */
export function parseSubscriptionRoute(pathname: string): SubscriptionRoute | null {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);

  if (segments.length >= 2 && segments[0]?.toLowerCase() === 'sub') {
    const token = normalizeToken(segments.slice(1).map(decodePathSegment).join('/'));

    if (!isValidToken(token)) {
      return null;
    }

    return {
      service: DEFAULT_SUBSCRIPTION_SERVICE,
      token,
    };
  }

  if (segments.length >= 3 && segments[1]?.toLowerCase() === 'sub') {
    const rawService = segments[0] ?? '';
    const service = normalizeServiceName(decodePathSegment(rawService));
    const token = normalizeToken(segments.slice(2).map(decodePathSegment).join('/'));

    if (!isValidServiceSegment(service) || !isValidToken(token)) {
      return null;
    }

    return { service, token };
  }

  return null;
}

/**
 * Selects backend target by service name, falling back to first configured target.
 */
export function resolveSubscriptionTarget(
  service: string,
  targets: readonly SubscriptionTarget[],
): SubscriptionTarget | null {
  if (targets.length === 0) {
    return null;
  }

  const normalizedService = normalizeServiceName(service);

  for (const target of targets) {
    if (target.name.toLowerCase() === normalizedService) {
      return target;
    }
  }

  return targets[0] ?? null;
}

/**
 * Builds backend URL for upstream subscription fetch.
 */
export function buildSubscriptionBackendUrl(
  target: SubscriptionTarget,
  token: string,
  originalUrl: URL,
): URL {
  const url = new URL(target.url);
  url.port = String(target.port);

  const normalizedBasePath = target.path.endsWith('/') ? target.path.slice(0, -1) : target.path;
  url.pathname = `${normalizedBasePath}/${encodeURIComponent(token)}`;
  url.search = originalUrl.search;
  return url;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function cloneHeadersForClient(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete('content-encoding');
  cloned.delete('content-length');
  return cloned;
}

function toMaxSizeError(): Error {
  const error = new Error('Subscription response exceeded size limit.');
  error.name = MAX_SIZE_ERROR_CODE;
  return error;
}

function isMaxSizeError(error: unknown): boolean {
  return error instanceof Error && error.name === MAX_SIZE_ERROR_CODE;
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

/**
 * Reads upstream response bodies with a strict byte cap using a dynamically
 * growing contiguous buffer to reduce intermediate allocations.
 */
async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = parseContentLength(response.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    throw toMaxSizeError();
  }

  if (contentLength === 0) {
    return new Uint8Array(0);
  }

  if (!response.body) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  let buffer = new Uint8Array(
    Math.max(
      1,
      Math.min(maxBytes, contentLength ?? INITIAL_READ_BUFFER_BYTES),
    ),
  );
  let totalLength = 0;
  let done = false;

  try {
    while (!done) {
      const readResult = await reader.read();

      if (readResult.done) {
        done = true;
        continue;
      }

      const chunk = readResult.value;
      totalLength += chunk.byteLength;

      if (totalLength > maxBytes) {
        await reader.cancel();
        throw toMaxSizeError();
      }

      const required = totalLength;
      if (required > buffer.byteLength) {
        let nextCapacity = buffer.byteLength;

        while (nextCapacity < required && nextCapacity < maxBytes) {
          nextCapacity = Math.min(maxBytes, nextCapacity * 2);
        }

        if (nextCapacity < required) {
          await reader.cancel();
          throw toMaxSizeError();
        }

        const nextBuffer = new Uint8Array(nextCapacity);
        nextBuffer.set(buffer.subarray(0, totalLength - chunk.byteLength));
        buffer = nextBuffer;
      }

      buffer.set(chunk, totalLength - chunk.byteLength);
    }
  } finally {
    reader.releaseLock();
  }

  return totalLength === buffer.byteLength ? buffer : buffer.slice(0, totalLength);
}

function toResponseBody(payload: Uint8Array): ArrayBuffer {
  const buffer = payload.buffer;

  if (buffer instanceof ArrayBuffer) {
    if (payload.byteOffset === 0 && payload.byteLength === buffer.byteLength) {
      return buffer;
    }

    return buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }

  const copied = new Uint8Array(payload.byteLength);
  copied.set(payload);
  return copied.buffer;
}

/**
 * Proxies one subscription request to selected backend with timeout and size limits.
 */
export async function proxySubscriptionRequest(
  request: Request,
  route: SubscriptionRoute,
  targets: readonly SubscriptionTarget[],
  options: SubscriptionProxyOptions = {},
): Promise<SubscriptionProxyResult> {
  const target = resolveSubscriptionTarget(route.service, targets);

  if (!target) {
    return {
      service: route.service,
      token: route.token,
      response: textResponse(503, 'No subscription target configured.'),
    };
  }

  const requestUrl = new URL(request.url);
  const backendUrl = buildSubscriptionBackendUrl(target, route.token, requestUrl);
  const headers = new Headers(request.headers);
  headers.delete('host');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SUBSCRIPTION_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(backendUrl.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    const payload = await readResponseBodyWithLimit(upstreamResponse, MAX_RESPONSE_SIZE_BYTES);
    const processedPayload =
      options.preserveDomain === true && upstreamResponse.status === 200
        ? preserveSubscriptionDomain(
            payload,
            upstreamResponse.headers.get('content-type'),
            buildDomainPreservationContext(target, route.token),
          )
        : payload;
    const responseBody = toResponseBody(processedPayload);

    const responseHeaders = cloneHeadersForClient(upstreamResponse.headers);
    responseHeaders.set('content-length', String(processedPayload.byteLength));

    return {
      service: target.name,
      token: route.token,
      response: new Response(responseBody, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      }),
    };
  } catch (error) {
    if (isMaxSizeError(error)) {
      return {
        service: target.name,
        token: route.token,
        response: textResponse(502, 'Subscription response exceeded size limit.'),
      };
    }

    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      service: target.name,
      token: route.token,
      response: textResponse(
        502,
        isAbort ? 'Subscription upstream request timed out.' : 'Unable to reach subscription upstream service.',
      ),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
