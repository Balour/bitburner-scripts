import type { NS } from '@ns';

/**
 * 1.70 GB (1.6 base + hack 0.1). Runs at high thread counts, so it must stay
 * pure: no imports, no logging, no analysis. Every extra GB here is paid per
 * thread.
 *
 * args: [target, delayMs?]
 */
export async function main(ns: NS) {
  const target = String(ns.args[0]);
  const wait = Number(ns.args[1] ?? 0);
  if (wait > 0) await ns.sleep(wait);
  await ns.hack(target);
}
