import { MAX_RETRIES } from '../config';
import { withBackendFailureMarker } from '../backend';
import type { Env } from '../types';
import {
  BACKEND_PASSTHROUGH_TIMEOUT_MS,
  BACKEND_UPGRADE_TIMEOUT_MS,
  fetchWithTimeout,
  isAbortError,
  normalizeRetryCount,
  waitForRetry,
} from '../utils/fetch';
import { textResponse } from '../utils/response';
import {
  bridgeSockets,
  buildBackendPassthroughHeaders,
  closeSocketPair,
  hasUpgradeRequest,
  parseBackendUrl,
  parseBackendUrlWithOverride,
  safeClose,
  toPassthroughInit,
} from '../utils/socket';
import { buildBackendUpgradeHeaders } from '../utils/ws-protocol';

function isDebugEnabled(env: Env): boolean {
  return env.DEBUG === 'true';
}

function validateRequest(request: Request): Response | null {
  void request;
  return null;
}

function resolveMaxAttempts(env: Env, backendOverride?: URL): number {
  if (backendOverride) {
    return 1;
  }

  const parsed = Number(env.MAX_RETRIES);
  return Math.max(1, normalizeRetryCount(parsed, MAX_RETRIES));
}

function shouldRetryUpgradeStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function handleUpgrade(
  request: Request,
  env: Env,
  backendOverride?: URL,
  onConnectionClosed?: () => void,
  onConnectionReady?: (disconnect: (code: number, reason: string) => void) => void,
): Promise<Response> {
  const validationError = validateRequest(request);

  if (validationError) {
    return validationError;
  }

  const debugEnabled = isDebugEnabled(env);
  const requestUrl = new URL(request.url);
  const hasUpgrade = hasUpgradeRequest(request, true);
  let backendUrl: URL;

  try {
    backendUrl = backendOverride
      ? parseBackendUrlWithOverride(backendOverride, requestUrl)
      : parseBackendUrl(request, env, requestUrl);
  } catch (error) {
    return textResponse(500, error instanceof Error ? error.message : 'Invalid backend configuration.');
  }

  if (!hasUpgrade) {
    const passthroughHeaders = buildBackendPassthroughHeaders(request);

    if (debugEnabled) {
      console.log('[ws]', 'forwarding non-upgrade ws request', {
        backendUrl: backendUrl.toString(),
        method: request.method,
      });
    }

    try {
      return await fetchWithTimeout(
        backendUrl.toString(),
        toPassthroughInit(request, passthroughHeaders),
        BACKEND_PASSTHROUGH_TIMEOUT_MS,
      );
    } catch (error) {
      if (isAbortError(error)) {
        return withBackendFailureMarker(textResponse(502, 'Backend request timed out.'));
      }

      if (debugEnabled) {
        console.error('[ws] backend passthrough error', error);
      }

      return withBackendFailureMarker(textResponse(502, 'Unable to connect to backend service.'));
    }
  }

  if (request.method.toUpperCase() !== 'GET') {
    return textResponse(400, 'ws upgrade requests must use GET.');
  }

  const socketPair = new WebSocketPair();
  const clientSocket = socketPair[0];
  const workerSocket = socketPair[1];
  workerSocket.accept();

  const backendHeaders = buildBackendUpgradeHeaders(request);
  const maxAttempts = resolveMaxAttempts(env, backendOverride);
  let lastStatus: number | null = null;
  let lastError: unknown = null;
  let lastErrorWasTimeout = false;

  if (debugEnabled) {
    console.log('[ws]', 'dialing backend', {
      backendUrl: backendUrl.toString(),
      subprotocol: backendHeaders.get('sec-websocket-protocol') ?? 'none',
      maxAttempts,
    });
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const backendResponse = await fetchWithTimeout(
        backendUrl.toString(),
        {
          method: 'GET',
          headers: backendHeaders,
          redirect: 'manual',
        },
        BACKEND_UPGRADE_TIMEOUT_MS,
        0,
      );

      if (backendResponse.status !== 101 || !backendResponse.webSocket) {
        lastStatus = backendResponse.status;
        await backendResponse.body?.cancel();

        const shouldRetry = attempt < maxAttempts && shouldRetryUpgradeStatus(backendResponse.status);
        if (!shouldRetry) {
          closeSocketPair(
            workerSocket,
            clientSocket,
            1011,
            `Backend upgrade rejected (${backendResponse.status})`,
          );
          return withBackendFailureMarker(
            textResponse(
              502,
              `Backend failed to upgrade ws connection (status ${backendResponse.status}, attempt ${attempt}/${maxAttempts}).`,
            ),
          );
        }

        if (debugEnabled) {
          console.warn('[ws] backend rejected upgrade attempt', {
            backendUrl: backendUrl.toString(),
            status: backendResponse.status,
            attempt,
            maxAttempts,
          });
        }
      } else {
        const backendSocket = backendResponse.webSocket;
        try {
          backendSocket.accept();

          bridgeSockets(
            workerSocket,
            backendSocket,
            (direction, error) => {
              if (debugEnabled) {
                console.log('[ws]', 'relay error', { direction, error });
              }
            },
            onConnectionClosed,
            onConnectionReady,
          );

          return new Response(null, {
            status: 101,
            webSocket: clientSocket,
          });
        } catch (error) {
          safeClose(backendSocket, 1011, 'Failed to initialize ws bridge');
          throw error;
        }
      }
    } catch (error) {
      lastError = error;
      lastErrorWasTimeout = isAbortError(error);

      if (debugEnabled) {
        console.error('[ws] backend connection attempt failed', {
          backendUrl: backendUrl.toString(),
          attempt,
          maxAttempts,
          error,
        });
      }

      if (attempt >= maxAttempts) {
        break;
      }
    }

    if (attempt < maxAttempts) {
      await waitForRetry(attempt - 1);
    }
  }

  closeSocketPair(workerSocket, clientSocket, 1011, 'Unable to connect to backend');

  if (lastErrorWasTimeout) {
    return withBackendFailureMarker(textResponse(502, `Backend ws upgrade timed out after ${maxAttempts} attempts.`));
  }

  if (lastStatus !== null) {
    return withBackendFailureMarker(
      textResponse(502, `Backend ws upgrade failed after ${maxAttempts} attempts (status ${lastStatus}).`),
    );
  }

  if (debugEnabled && lastError) {
    console.error('[ws] backend connection error', lastError);
  }

  return withBackendFailureMarker(
    textResponse(502, `Unable to connect to backend service for ws transport after ${maxAttempts} attempts.`),
  );
}
