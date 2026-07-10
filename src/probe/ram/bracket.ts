import type { NS } from '@ns';

/**
 * Literal bracket access: `ns['getServer']`. A parser could still see this string.
 * Expect 3.60 GB if it does, 1.60 GB if only dot access is detected.
 */
export async function main(ns: NS) {
  const fn = (ns as unknown as Record<string, (host: string) => { hostname: string }>)['getServer'];
  if (ns.args.length > 9999) {
    ns.tprint(fn('home').hostname);
  }
  ns.tprint(`bracket: ramOverride() reports ${ns.ramOverride()} GB`);
}
