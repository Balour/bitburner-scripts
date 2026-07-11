import type { NS } from '@ns';
import { buyRound, purchasedRam } from './lib/cloud';

/**
 * Converts cash into worker-pool RAM via ns.cloud (NOT Singularity — scriptable).
 * Purchased servers are auto-rooted and connected to home, so the daemon's crawl
 * picks them up as pool hosts with no further wiring.
 *
 * A ONE-SHOT: purchased servers do NOT survive an augmentation install, so
 * spending is a deliberate act. For hands-off spending use auto-buy.ts.
 *
 *   run /buy-servers.js                     spend all cash
 *   run /buy-servers.js --reserve 5e6       keep $5M back
 *   run /buy-servers.js --budget 20e6       spend at most $20M
 *   run /buy-servers.js --ram 128           force 128 GB servers
 */
export async function main(ns: NS) {
  const flags = ns.flags([
    ['reserve', 0],
    ['budget', 0],
    ['ram', 0],
  ]);
  const money = ns.getServerMoneyAvailable('home');
  const budget =
    Number(flags.budget) > 0
      ? Math.min(Number(flags.budget), money - Number(flags.reserve))
      : money - Number(flags.reserve);
  if (budget <= 0) {
    ns.tprint(`buy-servers: nothing to spend (money ${ns.format.number(money)})`);
    return;
  }

  const { bought, upgraded } = buyRound(ns, budget, Number(flags.ram));

  ns.tprint('');
  ns.tprint('=== buy-servers ===');
  ns.tprint(`  bought:   ${bought.length ? bought.join(', ') : 'none'}`);
  ns.tprint(`  upgraded: ${upgraded.length ? upgraded.join(', ') : 'none'}`);
  ns.tprint(
    `  purchased pool: ${ns.cloud.getServerNames().length}/${ns.cloud.getServerLimit()} servers, ${ns.format.ram(purchasedRam(ns))}`,
  );
  ns.tprint(`  cash left: ${ns.format.number(ns.getServerMoneyAvailable('home'))}`);
  ns.tprint('');
}
