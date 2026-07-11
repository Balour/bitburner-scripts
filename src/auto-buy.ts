import type { NS } from '@ns';
import { crawl, rooted } from './lib/net';
import { VERSION } from './lib/ports';
import { buyRound, purchasedRam } from './lib/cloud';

/**
 * Persistent. Spends surplus cash on purchased servers so income compounds into
 * pool RAM — but ONLY while the daemon is actually RAM-limited. If the pool has
 * idle capacity (few enough targets that the daemon can't fill it), buying more
 * is pure waste, so it holds off. This is what stops it ballooning the pool to
 * 100 TB when the work only needs ~15 TB.
 *
 * Keeps a reserve so it never empties the wallet before an augment install, which
 * wipes purchased servers.
 *
 *   run /auto-buy.js                    keep $100M reserve, buy at >85% pool use
 *   run /auto-buy.js --reserve 5e8      keep $500M for augments
 *   run /auto-buy.js --until 0.7        buy until the pool is 70% used
 */
export async function main(ns: NS) {
  ns.disableLog('ALL');
  const flags = ns.flags([
    ['reserve', 100e6],
    ['interval', 30],
    ['until', 0.85],
  ]);
  const reserve = Number(flags.reserve);
  const intervalMs = Number(flags.interval) * 1000;
  const until = Number(flags.until);
  ns.print(`auto-buy ${VERSION} starting`);

  while (true) {
    const hosts = rooted(ns, crawl(ns)).filter((h) => h !== 'home');
    let max = 0;
    let used = 0;
    for (const host of hosts) {
      max += ns.getServerMaxRam(host);
      used += ns.getServerUsedRam(host);
    }
    const util = max > 0 ? used / max : 1;
    const budget = ns.getServerMoneyAvailable('home') - reserve;

    // Only grow the pool when the daemon is straining against it. A pool with
    // spare RAM does not need more; buying would just sit idle and vanish on install.
    if (util >= until && budget > 0) {
      const { bought, upgraded, spent } = buyRound(ns, budget);
      if (bought.length || upgraded.length) {
        ns.print(
          `pool ${(100 * util).toFixed(0)}% used — spent $${ns.format.number(spent)}: ` +
            `+${bought.length} server(s), ${upgraded.length} upgrade(s), now ${ns.format.ram(purchasedRam(ns))}`,
        );
      }
    }
    await ns.sleep(intervalMs);
  }
}
