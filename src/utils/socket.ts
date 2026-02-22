import { BACKEND_LIST as DEFAULT_BACKEND_LIST, BACKEND_URL as DEFAULT_BACKEND_URL } from '../config';
import type { Env } from '../types';

export type WebSocketPayload = ArrayBuffer | ArrayBufferView | Blob | string;
type RelayDirection = 'client->backend' | 'backend->client';
type SocketConnectionState = 'connecting' | 'open' | 'closing' | 'closed' | 'errored';

interface BridgeConnectionState {
  client: SocketConnectionState;
  backend: SocketConnectionState;
}

export function hasUpgradeRequest(request: Request, strictWebSocketUpgrade: boolean): boolean {
  const connectionHasUpgrade = request.headers.get('Connection')?.toLowerCase().includes('upgrade') ?? false;
  const upgrade = request.headers.get('Upgrade');

  if (!connectionHasUpgrade || !upgrade) {
    return false;
  }

  if (!strictWebSocketUpgrade) {
    return true;
  }

  return upgrade.toLowerCase() === 'websocket';
}

function parseBackendList(rawBackendList: string): string[] {
  return rawBackendList
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => (entry.split('|', 2)[0] ?? '').trim())
    .filter((url) => url.length > 0);
}

function resolveBackendUrl(env: Env): string {
  const configuredBackendUrl = env.BACKEND_URL?.trim();

  if (configuredBackendUrl) {
    return configuredBackendUrl;
  }

  const configuredBackendList = parseBackendList(env.BACKEND_LIST ?? '');
  const defaultBackendList = DEFAULT_BACKEND_LIST.map((url) => url.trim()).filter((url) => url.length > 0);
  return configuredBackendList[0] ?? defaultBackendList[0] ?? DEFAULT_BACKEND_URL;
}

export function parseBackendUrl(request: Request, env: Env, inbound: URL = new URL(request.url)): URL {
  const rawBackendUrl = resolveBackendUrl(env);
  let backendUrl: URL;

  try {
    backendUrl = new URL(rawBackendUrl);
  } catch {
    throw new Error('BACKEND_URL is not a valid URL.');
  }

  // Preserve the user-requested path exactly (no Worker-side path injection).
  backendUrl.pathname = inbound.pathname;
  backendUrl.search = inbound.search;
  return backendUrl;
}

/**
 * Builds a request-specific backend URL from an explicit backend origin override.
 */
export function parseBackendUrlWithOverride(
  backendBaseUrl: URL | string,
  inbound: URL,
): URL {
  const rawBackendUrl = backendBaseUrl instanceof URL ? backendBaseUrl.toString() : backendBaseUrl;
  let backendUrl: URL;

  try {
    backendUrl = new URL(rawBackendUrl);
  } catch {
    throw new Error('BACKEND_URL is not a valid URL.');
  }

  // Preserve the user-requested path exactly (no Worker-side path injection).
  backendUrl.pathname = inbound.pathname;
  backendUrl.search = inbound.search;
  return backendUrl;
}

export function buildBackendPassthroughHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete('Host');
  return headers;
}

export function toPassthroughInit(request: Request, headers: Headers): RequestInit {
  const method = request.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    return {
      method,
      headers,
      redirect: 'manual',
    };
  }

  return {
    method,
    headers,
    body: request.body,
    redirect: 'manual',
  };
}

export function sanitizeCloseCode(code: number): number {
  if (Number.isInteger(code) && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006) {
    return code;
  }

  return 1011;
}

/**
 * Closes both sockets safely and ignores close failures.
 */
export function closeSocketPair(firstSocket: WebSocket, secondSocket: WebSocket, code: number, reason: string): void {
  safeClose(firstSocket, code, reason);
  safeClose(secondSocket, code, reason);
}

export function safeClose(socket: WebSocket, code: number, reason: string): void {
  const normalizedCode = sanitizeCloseCode(code);
  const normalizedReason = reason.slice(0, 123);

  try {
    socket.close(normalizedCode, normalizedReason);
  } catch {
    try {
      socket.close();
    } catch {
      // Ignore close errors; socket may already be closed.
    }
  }
}

function toSocketConnectionState(readyState: number): SocketConnectionState {
  switch (readyState) {
    case 0:
      return 'connecting';
    case 1:
      return 'open';
    case 2:
      return 'closing';
    case 3:
      return 'closed';
    default:
      return 'errored';
  }
}

function formatConnectionState(state: BridgeConnectionState): string {
  return `client=${state.client}, backend=${state.backend}`;
}

export function bridgeSockets(
  clientSocket: WebSocket,
  backendSocket: WebSocket,
  onRelayError: (direction: RelayDirection, error: unknown) => void,
  onClosed?: () => void,
  onReady?: (disconnect: (code: number, reason: string) => void) => void,
): void {
  let closed = false;
  let onClosedNotified = false;
  let cleanupListeners = (): void => undefined;
  const state: BridgeConnectionState = {
    client: toSocketConnectionState(clientSocket.readyState),
    backend: toSocketConnectionState(backendSocket.readyState),
  };

  const closeBoth = (code: number, reason: string): void => {
    if (closed) {
      return;
    }

    closed = true;
    state.client = state.client === 'closed' ? 'closed' : 'closing';
    state.backend = state.backend === 'closed' ? 'closed' : 'closing';
    cleanupListeners();
    closeSocketPair(clientSocket, backendSocket, code, reason);
    state.client = 'closed';
    state.backend = 'closed';

    if (!onClosedNotified && onClosed) {
      onClosedNotified = true;

      try {
        onClosed();
      } catch {
        // Ignore onClosed callback failures.
      }
    }
  };

  const onForwardFailure = (direction: RelayDirection, error: unknown): void => {
    onRelayError(direction, error);
    closeBoth(1011, 'Relay failure');
  };

  const forward = (destination: WebSocket, payload: WebSocketPayload, direction: RelayDirection): void => {
    if (payload instanceof Blob) {
      void payload
        .arrayBuffer()
        .then((arrayBuffer) => {
          if (closed) {
            return;
          }

          try {
            destination.send(arrayBuffer);
          } catch (error) {
            onForwardFailure(direction, error);
          }
        })
        .catch((error: unknown) => {
          onForwardFailure(direction, error);
        });
      return;
    }

    if (closed || destination.readyState !== 1) {
      return;
    }

    try {
      destination.send(payload);
    } catch (error) {
      onForwardFailure(direction, error);
    }
  };

  const onClientMessage = (event: MessageEvent): void => {
    forward(backendSocket, event.data as WebSocketPayload, 'client->backend');
  };

  const onBackendMessage = (event: MessageEvent): void => {
    forward(clientSocket, event.data as WebSocketPayload, 'backend->client');
  };

  const onClientClose = (event: CloseEvent): void => {
    state.client = 'closed';
    closeBoth(event.code, event.reason || 'Client closed connection');
  };

  const onBackendClose = (event: CloseEvent): void => {
    state.backend = 'closed';
    closeBoth(event.code, event.reason || 'Backend closed connection');
  };

  const onClientError = (): void => {
    state.client = 'errored';
    onRelayError(
      'client->backend',
      new Error(`Client socket error (${formatConnectionState(state)})`),
    );
    closeBoth(1011, 'Client socket error');
  };

  const onBackendError = (): void => {
    state.backend = 'errored';
    onRelayError(
      'backend->client',
      new Error(`Backend socket error (${formatConnectionState(state)})`),
    );
    closeBoth(1011, 'Backend socket error');
  };

  cleanupListeners = (): void => {
    clientSocket.removeEventListener('message', onClientMessage);
    backendSocket.removeEventListener('message', onBackendMessage);
    clientSocket.removeEventListener('close', onClientClose);
    backendSocket.removeEventListener('close', onBackendClose);
    clientSocket.removeEventListener('error', onClientError);
    backendSocket.removeEventListener('error', onBackendError);
  };

  clientSocket.addEventListener('message', onClientMessage);
  backendSocket.addEventListener('message', onBackendMessage);
  clientSocket.addEventListener('close', onClientClose);
  backendSocket.addEventListener('close', onBackendClose);
  clientSocket.addEventListener('error', onClientError);
  backendSocket.addEventListener('error', onBackendError);

  if (onReady) {
    try {
      onReady((code: number, reason: string) => {
        closeBoth(code, reason);
      });
    } catch {
      // Ignore onReady callback failures.
    }
  }
}
