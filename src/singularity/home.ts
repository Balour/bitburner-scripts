import type { NS } from '@ns';
import { strategyFor } from '../lib/strategy';
import { sing, reserve } from './api';

/**
 * P3 home upgrade (Singularity), one-shot. Doubles home RAM while affordable, up to `strat.home.ramCap`,
 * keeping `strat.augs.cashReserve` liquid. Home resets to 32 GB on entering a node, so this repeats each
 * run — but it's cheap and permanently ends script-RAM pressure. UNVERIFIED — validate in-game.
 *
 * Run: `run /singularity/home.js`
 */
const REV = 'v1';

export async function main(ns: NS) {
  reserve(ns, 12);
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);

  let n = 0;
  while (ns.getServerMaxRam('home') < strat.home.ramCap) {
    const cost = s['getUpgradeHomeRamCost']();
    if (ns.getServerMoneyAvailable('home') - cost < strat.augs.cashReserve) break;
    if (!s['upgradeHomeRam']()) break;
    n++;
  }
  if (n) ns.tprint(`=== home ${REV} — upgraded ${n}× to ${ns.format.ram(ns.getServerMaxRam('home'))} ===`);
}
