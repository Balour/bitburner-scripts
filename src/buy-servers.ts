import type { NS } from '@ns';

/**
 * 5.75 GB. Converts cash into worker-pool RAM via ns.cloud (NOT Singularity —
 * fully scriptable). Purchased servers are auto-rooted and connected to home, so
 * the daemon's crawl picks them up as pool hosts with no further wiring.
 *
 * A ONE-SHOT, not a loop: purchased servers do NOT survive an augmentation
 * install, and installs happen often, so spending is a deliberate act you invoke
 * — never an auto-drain that empties your wallet right before a reset.
 *
 * Buys the largest power-of-2 server each empty slot can afford, then upgrades
 * the smallest servers toward the RAM cap, until the budget runs out.
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
  const reserve = Number(flags.reserve);
  const cap = Number(flags.budget);
  const forceRam = Number(flags.ram);

  const money = ns.getServerMoneyAvailable('home');
  let budget = cap > 0 ? Math.min(cap, money - reserve) : money - reserve;
  if (budget <= 0) {
    ns.tprint(`buy-servers: nothing to spend (money ${ns.format.number(money)}, reserve ${ns.format.number(reserve)})`);
    return;
  }

  const limit = ns.cloud.getServerLimit();
  const ramLimit = ns.cloud.getRamLimit();
  const names = ns.cloud.getServerNames();

  const largestAffordable = (max: number, spend: number): number => {
    let r = 2;
    while (r * 2 <= max && ns.cloud.getServerCost(r * 2) <= spend) r *= 2;
    return ns.cloud.getServerCost(r) <= spend ? r : 0;
  };

  const bought: string[] = [];
  const upgraded: string[] = [];

  // Phase 1 — fill empty slots with new servers.
  let count = names.length;
  while (count < limit) {
    const r =
      forceRam > 0 ? (ns.cloud.getServerCost(forceRam) <= budget ? forceRam : 0) : largestAffordable(ramLimit, budget);
    if (r < 2) break;
    const host = ns.cloud.purchaseServer(`pserv-${count}`, r);
    if (host === '') break;
    budget -= ns.cloud.getServerCost(r);
    bought.push(`${host} ${ns.format.ram(r)}`);
    count += 1;
  }

  // Phase 2 — upgrade the smallest existing servers toward the cap.
  for (;;) {
    const owned = ns.cloud.getServerNames();
    const smallest = owned
      .map((h) => ({ h, ram: ns.getServerMaxRam(h) }))
      .filter((s) => s.ram < ramLimit)
      .sort((a, b) => a.ram - b.ram)[0];
    if (!smallest) break;

    const next = smallest.ram * 2;
    const upCost = ns.cloud.getServerUpgradeCost(smallest.h, next);
    if (upCost > budget) break;
    if (!ns.cloud.upgradeServer(smallest.h, next)) break;
    budget -= upCost;
    upgraded.push(`${smallest.h} -> ${ns.format.ram(next)}`);
  }

  const pool = ns.cloud.getServerNames().reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);
  ns.tprint('');
  ns.tprint('=== buy-servers ===');
  ns.tprint(`  bought:   ${bought.length ? bought.join(', ') : 'none'}`);
  ns.tprint(`  upgraded: ${upgraded.length ? upgraded.join(', ') : 'none'}`);
  ns.tprint(`  purchased pool: ${ns.cloud.getServerNames().length}/${limit} servers, ${ns.format.ram(pool)} total`);
  ns.tprint(`  cash left: ${ns.format.number(ns.getServerMoneyAvailable('home'))}`);
  ns.tprint('');
}
