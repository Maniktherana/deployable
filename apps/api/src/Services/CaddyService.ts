import { Context, Data, Effect, Layer } from "effect";

import { ApiConfig } from "../Config/ApiConfig.ts";

export class CaddyRouteError extends Data.TaggedError("CaddyRouteError")<{
  readonly message: string;
}> {}

export interface CaddyRoute {
  readonly hostname: string;
  readonly upstream: string;
}

export interface CaddyServiceShape {
  readonly addRoute: (route: CaddyRoute) => Effect.Effect<void, CaddyRouteError>;
  readonly removeRoute: (hostname: string) => Effect.Effect<void, CaddyRouteError>;
  readonly listRoutes: () => Effect.Effect<CaddyRoute[]>;
  readonly reconcileRoutes: (desired: CaddyRoute[]) => Effect.Effect<void, CaddyRouteError>;
}

export class CaddyService extends Context.Service<CaddyService, CaddyServiceShape>()(
  "@deployable/api/Services/CaddyService",
) {}

const MANAGED_GROUP = "deployable-managed";

const buildRouteConfig = (route: CaddyRoute) => ({
  group: MANAGED_GROUP,
  match: [{ host: [route.hostname.replace(/:.*$/, "")] }],
  handle: [
    {
      handler: "reverse_proxy",
      upstreams: [{ dial: route.upstream }],
    },
  ],
});

const parseRouteConfig = (entry: {
  match?: Array<{ host?: string[] }>;
  handle?: Array<{ handler?: string; upstreams?: Array<{ dial?: string }> }>;
}): CaddyRoute | null => {
  const host = entry.match?.[0]?.host?.[0];
  const dial = entry.handle?.[0]?.upstreams?.[0]?.dial;
  if (!host || !dial) return null;
  return { hostname: host, upstream: dial };
};

const ROUTES_PATH = "/config/apps/http/servers/srv0/routes";

export const CaddyServiceLive = Layer.effect(
  CaddyService,
  Effect.gen(function* () {
    const config = yield* ApiConfig;
    const adminUrl = config.caddyAdminUrl;

    const caddyFetch = (path: string, init?: RequestInit) =>
      fetch(`${adminUrl}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });

    const getRawRoutes = Effect.tryPromise({
      try: async () => {
        const res = await caddyFetch(ROUTES_PATH);
        if (res.status === 404) return [];
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`GET routes failed (${res.status}): ${body}`);
        }
        return (await res.json()) as Array<Record<string, unknown>>;
      },
      catch: (e) =>
        new CaddyRouteError({
          message: `getRawRoutes: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    const putRoutes = (routes: unknown[]) =>
      Effect.tryPromise({
        try: async () => {
          const res = await caddyFetch(ROUTES_PATH, {
            method: "PATCH",
            body: JSON.stringify(routes),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`PUT routes failed (${res.status}): ${body}`);
          }
        },
        catch: (e) =>
          new CaddyRouteError({
            message: `putRoutes: ${e instanceof Error ? e.message : String(e)}`,
          }),
      });

    const hostnameOf = (entry: Record<string, unknown>): string | undefined =>
      (entry as { match?: Array<{ host?: string[] }> }).match?.[0]?.host?.[0];

    const isManaged = (entry: Record<string, unknown>): boolean =>
      (entry as { group?: string }).group === MANAGED_GROUP;

    const addRoute: CaddyServiceShape["addRoute"] = (route) =>
      Effect.gen(function* () {
        const raw = yield* getRawRoutes;
        const host = route.hostname.replace(/:.*$/, "");
        const unmanaged = raw.filter((r) => !isManaged(r));
        const managed = raw.filter((r) => isManaged(r) && hostnameOf(r) !== host);
        managed.push(buildRouteConfig(route));
        yield* putRoutes([...managed, ...unmanaged]);
      });

    const removeRoute: CaddyServiceShape["removeRoute"] = (hostname) =>
      Effect.gen(function* () {
        const raw = yield* getRawRoutes;
        const host = hostname.replace(/:.*$/, "");
        const unmanaged = raw.filter((r) => !isManaged(r));
        const managed = raw.filter((r) => isManaged(r) && hostnameOf(r) !== host);
        yield* putRoutes([...managed, ...unmanaged]);
      });

    const listRoutes: CaddyServiceShape["listRoutes"] = () =>
      getRawRoutes.pipe(
        Effect.map((raw) =>
          raw
            .map((r) => parseRouteConfig(r as Parameters<typeof parseRouteConfig>[0]))
            .filter((r): r is CaddyRoute => r !== null),
        ),
        Effect.orDie,
      );

    const reconcileRoutes: CaddyServiceShape["reconcileRoutes"] = (desired) =>
      Effect.gen(function* () {
        const raw = yield* getRawRoutes;
        const unmanaged = raw.filter((r) => !isManaged(r));
        const desiredMap = new Map(desired.map((r) => [r.hostname.replace(/:.*$/, ""), r]));
        const newRoutes = [...desiredMap.values()].map(buildRouteConfig);
        yield* putRoutes([...newRoutes, ...unmanaged]);
      });

    return { addRoute, removeRoute, listRoutes, reconcileRoutes } satisfies CaddyServiceShape;
  }),
);
