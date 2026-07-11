import type { NS } from '@ns';

/**
 * 1.75 GB (1.6 base + grow 0.15). Pure worker — see workers/hack.ts.
 *
 * Grants `(3 + baseSecurity * 0.3) * threads` hacking exp with no level gate,
 * which is why this doubles as the XP engine.
 *
 * args: [target, delayMs?]
 */
export async function main(ns: NS) {
  const target = String(ns.args[0]);
  const wait = Number(ns.args[1] ?? 0);
  if (wait > 0) await ns.sleep(wait);
  await ns.grow(target);
}
