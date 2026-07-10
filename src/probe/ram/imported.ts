import type { NS } from '@ns';
import { peekHostname } from './lib';

/**
 * Calls `ns.getServer` only through an imported helper.
 * Expect 3.60 GB if the parser follows imports — which is why workers must never
 * import analysis helpers.
 */
export async function main(ns: NS) {
  if (ns.args.length > 9999) {
    ns.tprint(peekHostname(ns, 'home'));
  }
  ns.tprint(`imported: ramOverride() reports ${ns.ramOverride()} GB`);
}
