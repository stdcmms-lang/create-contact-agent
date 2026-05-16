import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./lib/auth-helpers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerContactsInvitesRoutes } from "./routes/contacts-invites.js";
import { registerMinimalConversationRoutes } from "./routes/conversations-minimal.js";
import { registerUserRoutes } from "./routes/users.js";

/** Ensures model types are part of the compilation unit */
export type {
  AuthSuccess,
  AuthTokens,
  BlockedUserEntry,
  DeviceSession,
  MeProfile,
  MfaChallenge,
} from "./types/models.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({
  logger: false,
  exposeHeadRoutes: false,
});

function primaryContentType(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) {return undefined;}
  return raw.split(";")[0]?.trim().toLowerCase();
}

function requestHasNonEmptyBody(request: FastifyRequest): boolean {
  const cl = request.headers["content-length"];
  if (typeof cl === "string" && cl.length > 0) {
    const n = Number.parseInt(cl, 10);
    if (Number.isFinite(n) && n > 0) {return true;}
  }
  if (typeof cl === "number" && cl > 0) {return true;}
  const te = request.headers["transfer-encoding"];
  return typeof te === "string" && te.toLowerCase().includes("chunked");
}

app.addHook("preValidation", async (request, reply) => {
  const m = request.method;
  if (m !== "POST" && m !== "PUT" && m !== "PATCH" && m !== "DELETE") {return;}
  if (!requestHasNonEmptyBody(request)) {return;}
  const ct = primaryContentType(request.headers["content-type"]);
  if (ct === undefined) {return;}
  if (ct === "application/json" || ct.endsWith("+json")) {return;}
  if (ct.startsWith("multipart/form-data")) {return;}
  return reply.code(415).send({
    error: {
      code: "unsupported_media_type",
      message: "JSON body requires application/json",
    },
  });
});

app.setErrorHandler((error, _request, reply) => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY") {
    return reply.code(400).send({
      error: { code: "invalid_request", message: "Request body is not valid JSON" },
    });
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return reply.code(415).send({
      error: { code: "unsupported_media_type", message: "Unsupported Content-Type" },
    });
  }
  if (error instanceof ApiError) {
    return reply
      .code(error.status)
      .send({ error: { code: error.code, message: error.message } });
  }
  return reply.send(error);
});

await registerAuthRoutes(app);
await registerUserRoutes(app);
await registerMinimalConversationRoutes(app);
await registerContactsInvitesRoutes(app);

await app.listen({ port: PORT, host: HOST });

// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    type: "server.listening",
    host: HOST,
    port: PORT,
    http: `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
  }),
);
