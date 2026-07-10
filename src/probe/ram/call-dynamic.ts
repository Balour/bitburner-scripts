import type { NS } from '@ns';
import { dynamicMethod } from './dyn';

/**
 * Calls a costed API the static parser never saw, WITHOUT raising the allocation.
 * This should hit the dynamic RAM check.
 *
 * Run: `run /probe/ram/call-dynamic.js`
 *
 * Outcomes:
 *  - "THREW (catchable)"  -> the dynamic check throws, and a script can recover.
 *  - script vanishes      -> the dynamic check is fatal and uncatchable.
 *  - "SUCCEEDED"          -> there is no dynamic check at all (unlikely).
 */
export async function main(ns: NS) {
  ns.tprint(`static allocation: ${ns.ramOverride()} GB`);
  const fetchServer = dynamicMethod<(host: string) => { hostname: string }>(ns, 'getServer');
  try {
    const server = fetchServer('home');
    ns.tprint(`SUCCEEDED without override -> ${server.hostname}`);
  } catch (e) {
    ns.tprint(`THREW (catchable) -> ${e}`);
  }
  ns.tprint(`still alive. static allocation is now: ${ns.ramOverride()} GB`);
}
