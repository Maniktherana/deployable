import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

export const healthRouteLayer = HttpRouter.add(
  "GET",
  "/health",
  HttpServerResponse.jsonUnsafe({ ok: true }),
);

export const apiHealthRouteLayer = HttpRouter.add(
  "GET",
  "/api/health",
  HttpServerResponse.jsonUnsafe({ ok: true }),
);
