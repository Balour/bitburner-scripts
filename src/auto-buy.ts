import type { NS } from '@ns';
import { PORT_RAMNEED, VERSION } from './lib/ports';
import { buyRound, purchasedRam } from './lib/cloud';

/**
 * Persistent. Spends surplus cash on purchased servers so income compounds into
 * pool RAM — but ONLY when the daemon signals its MONEY targets are RAM-starved
 * (PORT_RAMNEED = '1'). Raw utilization is not a usable trigger anymore: XP
 * farming fills any idle RAM, so the pool would read "full" forever and buying
 * would never stop. The daemon knows the difference and tells us.
 *
 * Keeps a reserve so it never empties the wallet before an augment install, which
 * wipes purchased servers.
 *
 *   run /auto-buy.js                    keep $100M reserve
 *   run /auto-buy.js --reserve 5e8      keep $500M for augments
 */
export async function main(ns: NS) {
  ns.disableLog('ALL');
  const flags = ns.flags([
    ['reserve', 100e6],
    ['interval', 30],
  ]);
  const reserve = Number(flags.reserve);
  const intervalMs = Number(flags.interval) * 1000;
  ns.print(`auto-buy ${VERSION} starting`);

  while (true) {
    const need = ns.peek(PORT_RAMNEED); // '1' when hacking is genuinely RAM-starved
    const budget = ns.getServerMoneyAvailable('home') - reserve;

    if (need === '1' && budget > 0) {
      const { bought, upgraded, spent } = buyRound(ns, budget);
      if (bought.length || upgraded.length) {
        ns.print(
          `hacking RAM-starved — spent $${ns.format.number(spent)}: ` +
            `+${bought.length} server(s), ${upgraded.length} upgrade(s), now ${ns.format.ram(purchasedRam(ns))}`,
        );
      }
    }
    await ns.sleep(intervalMs);
  }
}
