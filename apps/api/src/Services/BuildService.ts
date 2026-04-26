import { Context, Data, Effect, Layer, Queue, Stream } from "effect";

export class BuildError extends Data.TaggedError("BuildError")<{
  readonly message: string;
}> {}

export interface BuildServiceShape {
  readonly build: (opts: {
    sourceDir: string;
    imageTag: string;
    envVars?: Record<string, string>;
    buildCommand?: string;
    startCommand?: string;
  }) => Effect.Effect<Stream.Stream<string, BuildError>, BuildError>;
}

export class BuildService extends Context.Service<BuildService, BuildServiceShape>()(
  "@deployable/api/Services/BuildService",
) {}

const streamLines = (readable: ReadableStream<Uint8Array>): Stream.Stream<string, never> =>
  Stream.callback<string, never>((queue) =>
    Effect.sync(() => {
      const reader = readable.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const read = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              if (buffer.length > 0) Queue.offerUnsafe(queue, buffer);
              Queue.endUnsafe(queue);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              Queue.offerUnsafe(queue, line);
            }
            read();
          })
          .catch(() => Queue.endUnsafe(queue));
      };
      read();
    }),
  );

const collectOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
};

export const BuildServiceLive = Layer.succeed(BuildService, {
  build: ({ sourceDir, imageTag, envVars, buildCommand, startCommand }) =>
    Effect.gen(function* () {
      const planPath = `${sourceDir}/.railpack-plan.json`;
      const infoPath = `${sourceDir}/.railpack-info.json`;

      const prepareArgs = [
        "railpack",
        "prepare",
        sourceDir,
        "--plan-out",
        planPath,
        "--info-out",
        infoPath,
      ];
      if (envVars) {
        for (const [key, value] of Object.entries(envVars)) {
          prepareArgs.push("--env", `${key}=${value}`);
        }
      }
      const trimmedBuild = buildCommand?.trim();
      if (trimmedBuild) prepareArgs.push("--build-cmd", trimmedBuild);
      const trimmedStart = startCommand?.trim();
      if (trimmedStart) prepareArgs.push("--start-cmd", trimmedStart);

      const prepareProc = Bun.spawn(prepareArgs, { stdout: "pipe", stderr: "pipe" });
      const prepareExit = yield* Effect.tryPromise({
        try: () => prepareProc.exited,
        catch: (e) => new BuildError({ message: `railpack prepare spawn failed: ${e}` }),
      });

      if (prepareExit !== 0) {
        const stderr = yield* Effect.tryPromise({
          try: () => collectOutput(prepareProc.stderr),
          catch: () => new BuildError({ message: `railpack prepare failed (exit ${prepareExit})` }),
        });
        return yield* Effect.fail(
          new BuildError({ message: stderr || `railpack prepare exit ${prepareExit}` }),
        );
      }

      const buildArgs = [
        "docker",
        "buildx",
        "build",
        "--build-arg",
        "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend",
        "-f",
        planPath,
        "--load",
        "-t",
        imageTag,
        "--progress",
        "plain",
        sourceDir,
      ];

      const proc = Bun.spawn(buildArgs, { stdout: "pipe", stderr: "pipe" });
      const stdoutLines = streamLines(proc.stdout);
      const stderrLines = streamLines(proc.stderr);
      const merged = Stream.merge(stdoutLines, stderrLines);

      const exitCheck: Stream.Stream<string, BuildError> = Stream.fromEffect(
        Effect.tryPromise({
          try: () => proc.exited,
          catch: (e) => new BuildError({ message: `docker buildx failed: ${e}` }),
        }),
      ).pipe(
        Stream.flatMap((exitCode) =>
          exitCode !== 0
            ? Stream.fail(
                new BuildError({ message: `docker buildx build exited with code ${exitCode}` }),
              )
            : Stream.empty,
        ),
      );

      return Stream.concat(merged, exitCheck) as Stream.Stream<string, BuildError>;
    }),
});
