import type { NS } from '@ns';
import { liveStrategy } from '../lib/bitnode';
import { sing, reserveOk } from './api';

/**
 * P3 home upgrade (Singularity), one-shot. Two modes.
 *
 * NORMAL (`run /singularity/home.js`) — doubles home RAM while affordable, up to `strat.home.ramCap`,
 * keeping `strat.augs.cashReserve` liquid and taking a doubling only when it costs at most
 * `strat.home.costFraction` of current cash. Paced, because money still has other uses.
 *
 * DUMP (`--dump`, run by install.js in the moments before it resets) — the LAST use for cash that is about
 * to cease to exist. An install sets money to $1,000, so every dollar unspent at the reset is destroyed;
 * meanwhile home RAM and cores are among the very few things that SURVIVE it (`prestigeHomeComputer` clears
 * programs, network links, ramUsed and messages, never `maxRam` or `cpuCores` — they reset only on entering
 * a new BitNode). So the dump ignores the reserve, the cost fraction and `ramCap`, and buys until the money
 * is gone or the upgrades refuse.
 *
 * CORES FIRST, then RAM. Cores cap at 8, so that half is bounded and finishes; RAM then absorbs everything
 * left. Cores multiply the effect of `grow`/`weaken`/`share` for scripts running ON HOME — which matters
 * most exactly after an install, because purchased servers do NOT survive the reset and always have 1 core
 * anyway, so for the whole re-bootstrap window home IS the pool.
 *
 * Both upgrades are disabled outright by `bitNodeOptions.restrictHomePCUpgrade`, and that surfaces only as a
 * `false` return — hence break-on-false everywhere rather than trusting an affordability check.
 *
 * Run: `run /singularity/home.js`          paced upgrade, respects ramCap + costFraction
 *      `run /singularity/home.js --dump`   spend-it-all before an install (install.js does this)
 */
const REV = 'v2';
/** Backstop on the doubling loops — cost escalation ends them long before this. */
const MAX_STEPS = 60;

export async function main(ns: NS) {
  const flags = ns.flags([['dump', false]]);
  const dump = flags['dump'] as boolean;

  // +4.5 GB over v1 for the cores path: getUpgradeHomeCoresCost 1.5 + upgradeHomeCores 3.
  if (!reserveOk(ns, 16, 12)) return;
  const s = sing(ns);
  const strat = liveStrategy(ns, ns.getResetInfo().currentNode);
  const money = () => ns.getServerMoneyAvailable('home');
  const reserveCash = dump ? 0 : strat.augs.cashReserve;

  // Cores — dump only. Outside the dump they compete with augs for cash and rarely win.
  let cores = 0;
  if (dump) {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (s['getUpgradeHomeCoresCost']() > money()) break;
      if (!s['upgradeHomeCores']()) break; // at 8 cores, or upgrades restricted in this node
      cores++;
    }
  }

  const cap = dump ? strat.home.dumpRamCap : strat.home.ramCap;
  let n = 0;
  for (let i = 0; i < MAX_STEPS && ns.getServerMaxRam('home') < cap; i++) {
    const cost = s['getUpgradeHomeRamCost']();
    if (money() - cost < reserveCash) break; // never dip below the cash reserve (0 in a dump)
    // Pacing gate — normal mode only. In a dump there is no later stage to save for.
    if (!dump && cost > money() * strat.home.costFraction) break;
    if (!s['upgradeHomeRam']()) break;
    n++;
  }

  if (n || cores) {
    ns.tprint(
      `=== home ${REV}${dump ? ' [dump]' : ''} — ${n}x RAM to ${ns.format.ram(ns.getServerMaxRam('home'))}` +
        (cores ? ` · +${cores} core(s)` : '') +
        ' ===',
    );
  }
}
