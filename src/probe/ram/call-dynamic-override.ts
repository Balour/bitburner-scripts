import type { NS } from '@ns';
import { dynamicMethod } from './dyn';

/**
 * The candidate RAM-dodging pattern: stay cheap statically, raise the allocation
 * only when an expensive call is actually needed, then drop back down.
 *
 * Run: `run /probe/ram/call-dynamic-override.js`
 */
export async function main(ns: NS) {
  ns.tprint(`static allocation: ${ns.ramOverride()} GB`);

  const raised = ns.ramOverride(4);
  ns.tprint(`after ramOverride(4): ${raised} GB  ${raised === 4 ? '(raised)' : '(REFUSED)'}`);

  const fetchServer = dynamicMethod<(host: string) => { hostname: string; maxRam: number }>(ns, 'getServer');
  try {
    const server = fetchServer('home');
    ns.tprint(`CALL SUCCEEDED -> ${server.hostname} has ${server.maxRam} GB`);
  } catch (e) {
    ns.tprint(`CALL THREW -> ${e}`);
  }

  const lowered = ns.ramOverride(1.6);
  ns.tprint(
    `after ramOverride(1.6): ${lowered} GB  ${lowered === 1.6 ? '(lowered)' : '(REFUSED — dynamic usage is sticky)'}`,
  );
}
