import type { FastifyRequest } from "fastify";

const MAX_BODY_LOG_CHARS = 8192;

export type RequestLogPayload = {
  method: string;
  url: string;
  path: string;
  query: Record<string, unknown>;
  params: Record<string, string>;
  body: unknown;
};

function truncateForLog(value: string): string {
  if (value.length <= MAX_BODY_LOG_CHARS) {return value;}
  return `${value.slice(0, MAX_BODY_LOG_CHARS)}…[truncated]`;
}

export function buildRequestLogPayload(
  request: FastifyRequest,
): RequestLogPayload {
  const rawBody = request.body;
  let body: unknown = rawBody;

  if (typeof rawBody === "string") {
    body = truncateForLog(rawBody);
  } else if (rawBody !== null && rawBody !== undefined) {
    try {
      const serialized = JSON.stringify(rawBody);
      if (serialized.length > MAX_BODY_LOG_CHARS) {
        body = truncateForLog(serialized);
      }
    } catch {
      body = "[unserializable body]";
    }
  }

  const q = request.query;
  const query =
    q !== null && typeof q === "object" && !Array.isArray(q)
      ? { ...(q as Record<string, unknown>) }
      : {};

  const p = request.params;
  const params =
    p !== null && typeof p === "object" && !Array.isArray(p)
      ? { ...(p as Record<string, string>) }
      : {};

  return {
    method: request.method,
    url: request.url,
    path: request.url.split("?")[0] ?? request.url,
    query,
    params,
    body,
  };
}

export function logRequest(request: FastifyRequest): void {
  const payload = buildRequestLogPayload(request);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      type: "http.request",
      timestamp: Date.now(),
      ...payload,
    }),
  );
}
