import type { NS } from '@ns';
// Imported from `dyn`, not `lib`: `lib` references getServer and would confound
// this measurement if the parser counts whole imported modules.
import { dynamicMethod } from './dyn';

/**
 * Truly dynamic access: the method name comes from `ns.args`, so no static
 * analysis can resolve it. Expect 1.60 GB — the parser cannot see `getServer`.
 * If this reports 1.60, RAM dodging has a foothold.
 */
export async function main(ns: NS) {
  const fn = dynamicMethod<(host: string) => { hostname: string }>(ns, 'getServer');
  if (ns.args.length > 9999) {
    ns.tprint(fn('home').hostname);
  }
  ns.tprint(`variable: ramOverride() reports ${ns.ramOverride()} GB`);
}
