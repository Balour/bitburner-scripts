import type { NS } from '@ns';
import { strategyFor } from '../lib/strategy';
import { sing, reserveOk } from './api';

/**
 * P3 home upgrade (Singularity), one-shot. Doubles home RAM while affordable, up to `strat.home.ramCap`,
 * keeping `strat.augs.cashReserve` liquid. Home resets to 32 GB on entering a node, so this repeats each
 * run — but it's cheap and permanently ends script-RAM pressure. UNVERIFIED — validate in-game.
 *
 * Run: `run /singularity/home.js`
 */
const REV = 'v1';

export async function main(ns: NS) {
  if (!reserveOk(ns, 12, 6)) return;
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);

  let n = 0;
  while (ns.getServerMaxRam('home') < strat.home.ramCap) {
    const cost = s['getUpgradeHomeRamCost']();
    const money = ns.getServerMoneyAvailable('home');
    if (money - cost < strat.augs.cashReserve) break; // never dip below the cash reserve
    if (cost > money * strat.home.costFraction) break; // too pricey vs current wealth — wait for a later stage
    if (!s['upgradeHomeRam']()) break;
    n++;
  }
  if (n) ns.tprint(`=== home ${REV} — upgraded ${n}× to ${ns.format.ram(ns.getServerMaxRam('home'))} ===`);
}
