/**
 * Creates a UTF-8 plain-text response with consistent content-type header.
 */
export function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
