import { getCloudflareContext } from "@opennextjs/cloudflare";

export type ServiceBinding = Pick<Fetcher, "fetch">;

export interface LeetBattleCloudflareContext {
  env: CloudflareEnv;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Returns null under ordinary Node.js execution. Dynamic OpenNext routes have
 * a request context; keeping this lookup inside the request avoids I/O-bearing
 * bindings being captured in module scope.
 */
export function getLeetBattleCloudflareContext(): LeetBattleCloudflareContext | null {
  try {
    const context = getCloudflareContext();
    return {
      env: context.env,
      waitUntil: context.ctx.waitUntil.bind(context.ctx),
    };
  } catch {
    return null;
  }
}
