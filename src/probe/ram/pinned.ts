import type { NS } from '@ns';

/**
 * The sanctioned static pin. If the FIRST statement of `main` is
 * `ns.ramOverride(<numeric literal>)`, the parser discards its whole calculation
 * and uses that literal, provided it is >= 1.6.
 *
 * Expect 1.60 GB even though `ns.getServer` (2 GB) is referenced below.
 * Calling it would still be fatal without raising first — the pin lowers the
 * reservation, never the real cost.
 */
export async function main(ns: NS) {
  ns.ramOverride(1.6);
  if (ns.args.length > 9999) {
    ns.tprint(ns.getServer('home').hostname);
  }
  ns.tprint(`pinned: allocation is ${ns.ramOverride()} GB`);
}
