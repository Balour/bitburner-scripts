import type { NS } from '@ns';

/**
 * 1.75 GB (1.6 base + weaken 0.15). Pure worker — see workers/hack.ts.
 *
 * Lowers security by 0.05 per thread (single-core host). No level gate.
 *
 * args: [target, delayMs?]
 */
export async function main(ns: NS) {
  const target = String(ns.args[0]);
  const wait = Number(ns.args[1] ?? 0);
  if (wait > 0) await ns.sleep(wait);
  await ns.weaken(target);
}
