import type { NS } from '@ns';

/**
 * The naming hazard. The static parser harvests every *bare identifier name* and
 * matches it against the RAM cost table — it never checks the name was reached
 * through `ns`. So a local called `share` is charged ns.share's 2.4 GB.
 *
 * Expect 4.00 GB (1.60 base + 2.40) despite `ns.share` never being touched.
 */
export async function main(ns: NS) {
  const share = () => 'a local function that has nothing to do with ns.share';
  ns.tprint(`shadow: ${share().slice(0, 7)}... allocation is ${ns.ramOverride()} GB`);
}
