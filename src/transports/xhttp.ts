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
import {
  buildBackendUpgradeHeaders,
  parseEarlyDataFromWebSocketProtocolHeader,
  SEC_WEBSOCKET_PROTOCOL_HEADER,
} from '../utils/ws-protocol';

type XhttpMode = 'auto' | 'packet-up';
const MAX_EARLY_DATA_BYTES = 64 * 1024;
const ALLOWED_MODES: readonly XhttpMode[] = ['auto', 'packet-up'];

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

function parseEarlyDataHint(url: URL): number {
  const raw = url.searchParams.get('ed');

  if (raw === null) {
    return 0;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid early-data hint. The ed query parameter must be a non-negative integer.');
  }

  return Math.min(parsed, MAX_EARLY_DATA_BYTES);
}

function parseMode(url: URL, request: Request): XhttpMode {
  const fromQuery = url.searchParams.get('mode')?.toLowerCase();
  const fromHeader = request.headers.get('x-xhttp-mode')?.toLowerCase();
  const mode = fromQuery ?? fromHeader ?? 'auto';

  if ((ALLOWED_MODES as readonly string[]).includes(mode)) {
    return mode as XhttpMode;
  }

  throw new Error('Invalid xhttp mode. Supported values are auto and packet-up.');
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

  let earlyDataHint: number;
  let mode: XhttpMode;

  if (hasUpgrade) {
    try {
      earlyDataHint = parseEarlyDataHint(requestUrl);
      mode = parseMode(requestUrl, request);
    } catch (error) {
      return textResponse(400, error instanceof Error ? error.message : 'Invalid xhttp options.');
    }
  } else {
    earlyDataHint = 0;
    mode = 'auto';
  }

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
      console.log('[xhttp]', 'forwarding non-upgrade xhttp request', {
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
        console.error('[xhttp] backend passthrough error', error);
      }

      return withBackendFailureMarker(textResponse(502, 'Unable to connect to backend service.'));
    }
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
  let earlyDataForwardFailed = false;

  // xhttp early-data may be encoded in Sec-WebSocket-Protocol on some clients.
  const earlyDataResult = parseEarlyDataFromWebSocketProtocolHeader(
    request.headers.get(SEC_WEBSOCKET_PROTOCOL_HEADER),
    earlyDataHint,
  );
  if (earlyDataResult.errorMessage) {
    closeSocketPair(workerSocket, clientSocket, 1002, 'Invalid early-data');
    return textResponse(400, earlyDataResult.errorMessage);
  }
  const earlyDataChunk = earlyDataResult.data;
  if (earlyDataResult.shouldStripProtocolHeader) {
    // Prevent duplicated delivery when early-data is extracted and sent as first WS frame.
    backendHeaders.delete(SEC_WEBSOCKET_PROTOCOL_HEADER);
  }

  if (debugEnabled) {
    console.log('[xhttp]', 'dialing backend', {
      backendUrl: backendUrl.toString(),
      mode,
      earlyDataHint,
      earlyDataBytes: earlyDataChunk?.byteLength ?? 0,
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
              `Backend failed to upgrade xhttp connection (status ${backendResponse.status}, mode ${mode}, attempt ${attempt}/${maxAttempts}).`,
            ),
          );
        }

        if (debugEnabled) {
          console.warn('[xhttp] backend rejected upgrade attempt', {
            backendUrl: backendUrl.toString(),
            status: backendResponse.status,
            mode,
            attempt,
            maxAttempts,
          });
        }
      } else {
        const backendSocket = backendResponse.webSocket;
        try {
          backendSocket.accept();

          if (earlyDataChunk && earlyDataChunk.byteLength > 0) {
            try {
              backendSocket.send(earlyDataChunk);
            } catch (error) {
              earlyDataForwardFailed = true;
              throw error;
            }
          }

          bridgeSockets(
            workerSocket,
            backendSocket,
            (direction, error) => {
              if (debugEnabled) {
                console.log('[xhttp]', 'relay error', { direction, error });
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
          safeClose(
            backendSocket,
            1011,
            earlyDataForwardFailed ? 'Failed to forward early-data' : 'Failed to initialize xhttp bridge',
          );
          throw error;
        }
      }
    } catch (error) {
      lastError = error;
      lastErrorWasTimeout = isAbortError(error);

      if (debugEnabled) {
        console.error('[xhttp] backend connection attempt failed', {
          backendUrl: backendUrl.toString(),
          mode,
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

  if (earlyDataForwardFailed) {
    return withBackendFailureMarker(
      textResponse(502, `Failed to forward xhttp early-data after ${maxAttempts} attempts.`),
    );
  }

  if (lastErrorWasTimeout) {
    return withBackendFailureMarker(textResponse(502, `Backend xhttp upgrade timed out after ${maxAttempts} attempts.`));
  }

  if (lastStatus !== null) {
    return withBackendFailureMarker(
      textResponse(
        502,
        `Backend xhttp upgrade failed after ${maxAttempts} attempts (status ${lastStatus}, mode ${mode}).`,
      ),
    );
  }

  if (debugEnabled && lastError) {
    console.error('[xhttp] backend connection error', lastError);
  }

  return withBackendFailureMarker(
    textResponse(
      502,
      `Unable to connect to backend service for xhttp transport after ${maxAttempts} attempts.`,
    ),
  );
}
