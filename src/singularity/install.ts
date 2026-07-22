import type { NS } from '@ns';
import { strategyFor } from '../lib/strategy';
import { sing, reserveOk } from './api';

/**
 * P2 install (Singularity), one-shot. Owns the install DECISION so the controller stays lean: it checks
 * the config trigger (autoInstall + at least `install.minAugsQueued` queued) and only then installs and
 * relaunches the stack via `/bootstrap.js`. THIS RESETS THE GAME. No-op otherwise. The controller exec's
 * it on a timer. UNVERIFIED — validate before trusting the reset loop.
 *
 * Run: `run /singularity/install.js`         respect the config trigger
 *      `run /singularity/install.js --force`  install now if anything is queued
 */
const REV = 'v1';

export async function main(ns: NS) {
  const flags = ns.flags([['force', false]]);
  if (!reserveOk(ns, 16, 12)) return;
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);

  const queued = s['getOwnedAugmentations'](true).length - s['getOwnedAugmentations'](false).length;
  if (queued <= 0) return; // nothing to install; stay quiet on the timer

  const force = flags['force'] as boolean;
  if (!force && (!strat.install.autoInstall || queued < strat.install.minAugsQueued)) {
    ns.print(
      `install: ${queued} queued, trigger not met (autoInstall=${strat.install.autoInstall}, min ${strat.install.minAugsQueued})`,
    );
    return;
  }

  ns.tprint(`=== install ${REV} — installing ${queued} queued aug(s), relaunching /bootstrap.js ===`);
  s['installAugmentations']('/bootstrap.js'); // resets the game; runs the callback afterwards
}
