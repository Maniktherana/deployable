/** API allows 1–16 parallel in-flight build/deploy commands (see apps/api settings). */
export const DEPLOYMENT_CONCURRENCY_MIN = 1;
export const DEPLOYMENT_CONCURRENCY_MAX = 16;

export const PARALLEL_BUILD_CHOICES: readonly number[] = Object.freeze(
  Array.from(
    { length: DEPLOYMENT_CONCURRENCY_MAX - DEPLOYMENT_CONCURRENCY_MIN + 1 },
    (_, i) => i + DEPLOYMENT_CONCURRENCY_MIN,
  ),
);

export function clampDeploymentConcurrency(n: number): number {
  return Math.min(DEPLOYMENT_CONCURRENCY_MAX, Math.max(DEPLOYMENT_CONCURRENCY_MIN, n));
}
