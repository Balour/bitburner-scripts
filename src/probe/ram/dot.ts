import type { NS } from '@ns';

/**
 * Plain `ns.getServer` (2 GB) behind a branch that never runs.
 * Tests whether the static parser counts a reference it can see but never executes.
 * Expect 3.60 GB if dead references are counted.
 */
export async function main(ns: NS) {
  if (ns.args.length > 9999) {
    ns.tprint(ns.getServer('home').hostname);
  }
  ns.tprint(`dot: ramOverride() reports ${ns.ramOverride()} GB`);
}
