import type { SubscriptionTarget } from './types';

const PLAIN_URL_REGEX = /https?:\/\/[^\s"'<>]+/g;
const ESCAPED_URL_REGEX = /https?:\\\/\\\/[^\s"'<>]+/g;
const BASE64_TEXT_REGEX = /^[A-Za-z0-9+/_=\r\n-]+$/;
const MIN_BASE64_TEXT_LENGTH = 16;

export interface DomainPreservationContext {
  token: string;
  targetOrigin: string;
  targetPathPrefix: string;
}

function normalizeTargetPath(path: string): string {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return normalized.length > 0 ? normalized : '/sub';
}

/**
 * Builds normalized rewrite context used by domain-preservation transforms.
 */
export function buildDomainPreservationContext(target: SubscriptionTarget, token: string): DomainPreservationContext {
  const parsed = new URL(target.url);
  parsed.port = String(target.port);
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';

  return {
    token,
    targetOrigin: `${parsed.protocol}//${parsed.host}`,
    targetPathPrefix: normalizeTargetPath(target.path),
  };
}

function shouldRewriteSubscriptionUrl(parsedUrl: URL, context: DomainPreservationContext): boolean {
  const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;

  if (origin === context.targetOrigin) {
    return false;
  }

  const rawToken = context.token;
  const encodedToken = encodeURIComponent(context.token);
  const hasToken =
    parsedUrl.pathname.includes(rawToken) ||
    parsedUrl.pathname.includes(encodedToken) ||
    parsedUrl.search.includes(rawToken) ||
    parsedUrl.search.includes(encodedToken);

  if (!hasToken) {
    return false;
  }

  return (
    parsedUrl.pathname.startsWith(`${context.targetPathPrefix}/`) ||
    parsedUrl.pathname === context.targetPathPrefix ||
    parsedUrl.pathname.includes('/sub/')
  );
}

function rewriteSubscriptionUrl(rawUrl: string, context: DomainPreservationContext): string {
  try {
    const parsedUrl = new URL(rawUrl);

    if (!shouldRewriteSubscriptionUrl(parsedUrl, context)) {
      return rawUrl;
    }

    return `${context.targetOrigin}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return rawUrl;
  }
}

function rewriteTextPayload(input: string, context: DomainPreservationContext): string {
  const plainRewritten = input.replace(PLAIN_URL_REGEX, (rawUrl) => rewriteSubscriptionUrl(rawUrl, context));

  return plainRewritten.replace(ESCAPED_URL_REGEX, (escapedUrl) => {
    const unescaped = escapedUrl.replace(/\\\//g, '/');
    const rewritten = rewriteSubscriptionUrl(unescaped, context);

    if (rewritten === unescaped) {
      return escapedUrl;
    }

    return rewritten.replace(/\//g, '\\/');
  });
}

function normalizeBase64Input(value: string): string {
  return value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
}

function tryDecodeBase64Text(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed || trimmed.includes('://') || !BASE64_TEXT_REGEX.test(trimmed)) {
    return null;
  }

  const normalized = normalizeBase64Input(trimmed);

  if (normalized.length < MIN_BASE64_TEXT_LENGTH) {
    return null;
  }

  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(paddingNeeded);

  try {
    return atob(padded);
  } catch {
    return null;
  }
}

function encodeBase64Text(value: string, useUrlSafe: boolean, keepPadding: boolean): string | null {
  try {
    let encoded = btoa(value);

    if (useUrlSafe) {
      encoded = encoded.replace(/\+/g, '-').replace(/\//g, '_');
    }

    if (!keepPadding) {
      encoded = encoded.replace(/=+$/g, '');
    }

    return encoded;
  } catch {
    return null;
  }
}

function isLikelyTextPayload(payload: Uint8Array, contentType: string | null): boolean {
  const normalizedType = contentType?.toLowerCase() ?? '';

  if (
    normalizedType.includes('text/') ||
    normalizedType.includes('json') ||
    normalizedType.includes('xml') ||
    normalizedType.includes('yaml') ||
    normalizedType.includes('application/octet-stream')
  ) {
    return true;
  }

  if (payload.byteLength === 0) {
    return false;
  }

  const sampleSize = Math.min(payload.byteLength, 512);
  let printableBytes = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    const value = payload[index] ?? 0;

    if (value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126)) {
      printableBytes += 1;
    }
  }

  return printableBytes / sampleSize >= 0.85;
}

/**
 * Preserves configured target domain in subscription responses.
 *
 * Complexity:
 * - O(n) scan and replacement for direct text payloads
 * - Optional O(n) decode/rewrite/re-encode for base64 text payloads
 *
 * The transform is intentionally single-pass per representation to bound latency
 * on large subscription payloads.
 */
export function preserveSubscriptionDomain(
  payload: Uint8Array,
  contentType: string | null,
  context: DomainPreservationContext,
): Uint8Array {
  if (!isLikelyTextPayload(payload, contentType)) {
    return payload;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const textPayload = decoder.decode(payload);

  const rewrittenText = rewriteTextPayload(textPayload, context);

  if (rewrittenText !== textPayload) {
    return encoder.encode(rewrittenText);
  }

  const decodedBase64 = tryDecodeBase64Text(textPayload);
  if (!decodedBase64) {
    return payload;
  }

  const rewrittenBase64Body = rewriteTextPayload(decodedBase64, context);
  if (rewrittenBase64Body === decodedBase64) {
    return payload;
  }

  const normalizedBase64 = normalizeBase64Input(textPayload.trim());
  const useUrlSafe = /[-_]/.test(textPayload);
  const keepPadding = /=/.test(normalizedBase64);
  const reencoded = encodeBase64Text(rewrittenBase64Body, useUrlSafe, keepPadding);

  if (!reencoded) {
    return payload;
  }

  return encoder.encode(reencoded);
}
