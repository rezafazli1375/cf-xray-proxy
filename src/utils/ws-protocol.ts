export const SEC_WEBSOCKET_PROTOCOL_HEADER = 'sec-websocket-protocol';

const SEC_WEBSOCKET_EXTENSIONS_HEADER = 'sec-websocket-extensions';
const KNOWN_PROTOCOL_NEGOTIATION_TOKENS = new Set(['trojan', 'vless', 'vmess']);

export interface ParsedWebSocketProtocolHeader {
  tokens: string[];
  negotiationTokens: string[];
  auxiliaryTokens: string[];
}

export interface EarlyDataParseResult {
  data: Uint8Array | null;
  errorMessage: string | null;
  shouldStripProtocolHeader: boolean;
}

function isLikelyBase64UrlToken(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array {
  const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(paddingNeeded);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }

  return output;
}

function encodeUint8ArrayToBase64Url(input: Uint8Array): string {
  let binary = '';

  for (const value of input) {
    binary += String.fromCharCode(value);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isCanonicalBase64UrlToken(token: string): boolean {
  try {
    const decoded = decodeBase64UrlToUint8Array(token);
    return encodeUint8ArrayToBase64Url(decoded) === token;
  } catch {
    return false;
  }
}

/**
 * Parses Sec-WebSocket-Protocol into explicit protocol tokens and auxiliary tokens.
 */
export function parseWebSocketProtocolHeader(headerValue: string | null): ParsedWebSocketProtocolHeader {
  const tokens = (headerValue ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const negotiationTokens: string[] = [];
  const auxiliaryTokens: string[] = [];

  for (const token of tokens) {
    if (KNOWN_PROTOCOL_NEGOTIATION_TOKENS.has(token.toLowerCase())) {
      negotiationTokens.push(token);
      continue;
    }

    auxiliaryTokens.push(token);
  }

  return {
    tokens,
    negotiationTokens,
    auxiliaryTokens,
  };
}

/**
 * Builds backend upgrade headers while preserving protocol negotiation tokens.
 */
export function buildBackendUpgradeHeaders(request: Request, upgradeValue = 'websocket'): Headers {
  const headers = new Headers(request.headers);
  headers.delete('Host');
  headers.set('Connection', 'Upgrade');
  headers.set('Upgrade', upgradeValue);
  headers.delete(SEC_WEBSOCKET_EXTENSIONS_HEADER);

  const parsedProtocolHeader = parseWebSocketProtocolHeader(headers.get(SEC_WEBSOCKET_PROTOCOL_HEADER));
  if (parsedProtocolHeader.tokens.length === 0) {
    headers.delete('Sec-WebSocket-Protocol');
  } else {
    headers.set('Sec-WebSocket-Protocol', parsedProtocolHeader.tokens.join(', '));
  }

  return headers;
}

/**
 * Parses optional xhttp early-data from Sec-WebSocket-Protocol without consuming known protocol tokens.
 */
export function parseEarlyDataFromWebSocketProtocolHeader(
  headerValue: string | null,
  maxBytes: number,
): EarlyDataParseResult {
  if (maxBytes <= 0) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }

  const parsedProtocolHeader = parseWebSocketProtocolHeader(headerValue);
  if (parsedProtocolHeader.tokens.length === 0) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }

  if (parsedProtocolHeader.negotiationTokens.length > 0) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }

  if (parsedProtocolHeader.tokens.length !== 1) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }

  const token = parsedProtocolHeader.tokens[0];
  if (!token || !isLikelyBase64UrlToken(token) || !isCanonicalBase64UrlToken(token)) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }

  const decoded = decodeBase64UrlToUint8Array(token);
  if (decoded.byteLength > maxBytes) {
    return {
      data: null,
      errorMessage: `xhttp early-data exceeds limit (${decoded.byteLength} > ${maxBytes} bytes).`,
      shouldStripProtocolHeader: false,
    };
  }

  return {
    data: decoded,
    errorMessage: null,
    shouldStripProtocolHeader: true,
  };
}
