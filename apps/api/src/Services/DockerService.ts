import { Context, Data, Effect, Layer } from "effect";

export class ContainerStartError extends Data.TaggedError("ContainerStartError")<{
  readonly message: string;
}> {}

export class ContainerStopError extends Data.TaggedError("ContainerStopError")<{
  readonly message: string;
}> {}

export class ContainerInspectError extends Data.TaggedError("ContainerInspectError")<{
  readonly message: string;
}> {}

export interface ContainerInfo {
  readonly containerId: string;
  readonly name: string;
  readonly state: "running" | "exited" | "created" | "dead" | "unknown";
  readonly ports: ReadonlyArray<{ hostPort: number; containerPort: number }>;
}

export interface DockerServiceShape {
  readonly runContainer: (opts: {
    imageTag: string;
    name: string;
    envVars: Record<string, string>;
    labels: Record<string, string>;
    network: string;
    portOverride?: number;
  }) => Effect.Effect<ContainerInfo, ContainerStartError>;

  readonly stopContainer: (containerId: string) => Effect.Effect<void, ContainerStopError>;

  readonly removeContainer: (containerId: string) => Effect.Effect<void, ContainerStopError>;

  readonly inspectContainer: (
    containerId: string,
  ) => Effect.Effect<ContainerInfo, ContainerInspectError>;

  readonly waitForHealthy: (opts: {
    containerId: string;
    healthPath: string;
    port: number;
    timeoutMs: number;
  }) => Effect.Effect<boolean, ContainerInspectError>;

  readonly findContainersByLabel: (label: string, value: string) => Effect.Effect<ContainerInfo[]>;

  readonly ensureNetwork: (name: string) => Effect.Effect<void>;
}

export class DockerService extends Context.Service<DockerService, DockerServiceShape>()(
  "@deployable/api/Services/DockerService",
) {}

const DOCKER_SOCKET = "/var/run/docker.sock";

const dockerFetch = (path: string, init?: RequestInit) =>
  fetch(`http://localhost${path}`, {
    ...init,
    unix: DOCKER_SOCKET,
  });

function parseContainerState(status: string): ContainerInfo["state"] {
  switch (status) {
    case "running":
      return "running";
    case "exited":
      return "exited";
    case "created":
      return "created";
    case "dead":
      return "dead";
    default:
      return "unknown";
  }
}

function parsePorts(
  portsObj: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined,
): ContainerInfo["ports"] {
  if (!portsObj) return [];
  const result: Array<{ hostPort: number; containerPort: number }> = [];
  for (const [containerPortKey, bindings] of Object.entries(portsObj)) {
    if (!bindings) continue;
    const containerPort = parseInt(containerPortKey, 10);
    for (const binding of bindings) {
      const hostPort = parseInt(binding.HostPort, 10);
      if (!isNaN(hostPort) && !isNaN(containerPort)) {
        result.push({ hostPort, containerPort });
      }
    }
  }
  return result;
}

function parseInspectResponse(json: Record<string, any>): ContainerInfo {
  const name = (json.Name as string).replace(/^\//, "");
  return {
    containerId: json.Id as string,
    name,
    state: parseContainerState(json.State?.Status ?? "unknown"),
    ports: parsePorts(json.NetworkSettings?.Ports),
  };
}

function parseListItem(json: Record<string, any>): ContainerInfo {
  const names: string[] = json.Names ?? [];
  const name = (names[0] ?? "").replace(/^\//, "");
  const ports: Array<{ hostPort: number; containerPort: number }> = [];
  for (const p of json.Ports ?? []) {
    if (p.PublicPort && p.PrivatePort) {
      ports.push({ hostPort: p.PublicPort, containerPort: p.PrivatePort });
    }
  }
  return {
    containerId: json.Id as string,
    name,
    state: parseContainerState(json.State ?? "unknown"),
    ports,
  };
}

const ensureNetworkImpl = (name: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const resp = await dockerFetch("/networks");
      if (!resp.ok) throw new Error(`Failed to list networks: ${resp.status}`);
      const networks: Array<{ Name: string }> = await resp.json();
      if (networks.some((n) => n.Name === name)) return;

      const createResp = await dockerFetch("/networks/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Name: name, Driver: "bridge" }),
      });
      if (!createResp.ok) {
        const body = await createResp.text();
        throw new Error(`Failed to create network "${name}": ${body}`);
      }
    },
    catch: (cause) => {
      if (cause instanceof Error) return cause;
      return new Error(String(cause));
    },
  }).pipe(Effect.ignore);

const inspectContainerImpl = (
  containerId: string,
): Effect.Effect<ContainerInfo, ContainerInspectError> =>
  Effect.tryPromise({
    try: async () => {
      const resp = await dockerFetch(`/containers/${containerId}/json`);
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Failed to inspect container: ${body}`);
      }
      const json = await resp.json();
      return parseInspectResponse(json as Record<string, any>);
    },
    catch: (cause) =>
      new ContainerInspectError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const DockerServiceLive = Layer.succeed(DockerService, {
  ensureNetwork: ensureNetworkImpl,

  runContainer: ({ imageTag, name, envVars, labels, network, portOverride }) =>
    Effect.gen(function* () {
      yield* ensureNetworkImpl(network);

      const envArray = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
      const allLabels = { ...labels, "deployable.managed": "true" };

      const hostConfig: Record<string, any> = {
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" },
      };

      const exposedPorts: Record<string, object> = {};

      if (portOverride != null) {
        const portKey = `${portOverride}/tcp`;
        exposedPorts[portKey] = {};
        hostConfig.PortBindings = {
          [portKey]: [{ HostPort: String(portOverride) }],
        };
      }

      const createBody = {
        Image: imageTag,
        Env: envArray,
        Labels: allLabels,
        ExposedPorts: exposedPorts,
        HostConfig: hostConfig,
      };

      const createResp = yield* Effect.tryPromise({
        try: async () => {
          const resp = await dockerFetch(`/containers/create?name=${encodeURIComponent(name)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(createBody),
          });
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Failed to create container: ${body}`);
          }
          return (await resp.json()) as { Id: string };
        },
        catch: (cause) =>
          new ContainerStartError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });

      const containerId = createResp.Id;

      yield* Effect.tryPromise({
        try: async () => {
          const resp = await dockerFetch(`/containers/${containerId}/start`, {
            method: "POST",
          });
          if (!resp.ok && resp.status !== 304) {
            const body = await resp.text();
            throw new Error(`Failed to start container: ${body}`);
          }
        },
        catch: (cause) =>
          new ContainerStartError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });

      return yield* inspectContainerImpl(containerId).pipe(
        Effect.mapError((e) => new ContainerStartError({ message: e.message })),
      );
    }),

  stopContainer: (containerId) =>
    Effect.tryPromise({
      try: async () => {
        // t=2 (default 10) — keeps the UI responsive for containers that ignore SIGTERM.
        const resp = await dockerFetch(`/containers/${containerId}/stop?t=2`, {
          method: "POST",
        });
        if (!resp.ok && resp.status !== 304) {
          const body = await resp.text();
          throw new Error(`Failed to stop container: ${body}`);
        }
      },
      catch: (cause) =>
        new ContainerStopError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  removeContainer: (containerId) =>
    Effect.tryPromise({
      try: async () => {
        const resp = await dockerFetch(`/containers/${containerId}?force=true`, {
          method: "DELETE",
        });
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`Failed to remove container: ${body}`);
        }
      },
      catch: (cause) =>
        new ContainerStopError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  inspectContainer: inspectContainerImpl,

  waitForHealthy: ({ containerId, healthPath, port, timeoutMs }) =>
    Effect.tryPromise({
      try: async () => {
        const inspectResp = await dockerFetch(`/containers/${containerId}/json`);
        if (!inspectResp.ok) throw new Error("Failed to inspect container for health check");
        const inspectJson = (await inspectResp.json()) as Record<string, any>;

        const networks = inspectJson.NetworkSettings?.Networks ?? {};
        let ip: string | undefined;
        for (const net of Object.values(networks) as Array<{ IPAddress?: string }>) {
          if (net.IPAddress) {
            ip = net.IPAddress;
            break;
          }
        }
        if (!ip) throw new Error("Container has no IP address");

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            const resp = await fetch(`http://${ip}:${port}${healthPath}`, {
              signal: AbortSignal.timeout(2000),
            });
            if (resp.ok) return true;
          } catch {
            // not ready yet
          }
          await Bun.sleep(2000);
        }
        return false;
      },
      catch: (cause) =>
        new ContainerInspectError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  findContainersByLabel: (label, value) =>
    Effect.tryPromise({
      try: async () => {
        const filters = JSON.stringify({ label: [`${label}=${value}`] });
        const resp = await dockerFetch(
          `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
        );
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`Failed to list containers: ${body}`);
        }
        const items: Array<Record<string, any>> = await resp.json();
        return items.map(parseListItem);
      },
      catch: (cause) => {
        if (cause instanceof Error) return cause;
        return new Error(String(cause));
      },
    }).pipe(Effect.orElseSucceed(() => [] as ContainerInfo[])),
});
