import type { NS } from '@ns';
import { sing, reserveOk } from './api';

/**
 * P3 endgame (Singularity), one-shot. Destroys w0r1d_d43m0n and enters the next BitNode, relaunching the
 * stack via `/bootstrap.js`. The controller only exec's this when the config's `endgame.autoDestroy` is
 * set AND the hacking requirement is met — by default it merely NOTIFIES, since leaving a node is a big
 * strategic choice. UNVERIFIED — validate the hacking gate and reqs in-game first.
 *
 * Run: `run /singularity/endgame.js <nextBN>`
 */
const REV = 'v1';

export async function main(ns: NS) {
  if (!reserveOk(ns, 40, 34)) return; // destroyW0r1dD43m0n is 32 GB base
  const s = sing(ns);
  const nextBN = Number(ns.args[0] ?? ns.getResetInfo().currentNode);
  ns.tprint(`=== endgame ${REV} — destroying w0r1d_d43m0n, entering BN${nextBN} ===`);
  s['destroyW0r1dD43m0n'](nextBN, '/bootstrap.js'); // resets into the next node; runs the callback there
}
