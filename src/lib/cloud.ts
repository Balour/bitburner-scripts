import type { NS } from '@ns';

/**
 * Purchased-server buying, shared by buy-servers.ts (one-shot) and auto-buy.ts
 * (loop). Importing this carries the ns.cloud RAM costs (~4 GB), which both
 * callers need anyway.
 */

export interface BuyResult {
  bought: string[];
  upgraded: string[];
  spent: number;
}

/**
 * One pass: fill empty server slots with the largest power-of-2 each can afford,
 * then upgrade the smallest servers toward the RAM cap — all within `budget`.
 * Returns what it did. Does nothing (empty result) when budget or slots run out.
 */
export function buyRound(ns: NS, budget: number, forceRam = 0): BuyResult {
  const limit = ns.cloud.getServerLimit();
  const ramLimit = ns.cloud.getRamLimit();
  const bought: string[] = [];
  const upgraded: string[] = [];
  let left = budget;

  const largestAffordable = (spend: number): number => {
    let r = 2;
    while (r * 2 <= ramLimit && ns.cloud.getServerCost(r * 2) <= spend) r *= 2;
    return ns.cloud.getServerCost(r) <= spend ? r : 0;
  };

  // Fill empty slots.
  let count = ns.cloud.getServerNames().length;
  while (count < limit) {
    const r = forceRam > 0 ? (ns.cloud.getServerCost(forceRam) <= left ? forceRam : 0) : largestAffordable(left);
    if (r < 2) break;
    const host = ns.cloud.purchaseServer(`pserv-${count}`, r);
    if (host === '') break;
    left -= ns.cloud.getServerCost(r);
    bought.push(`${host} ${ns.format.ram(r)}`);
    count += 1;
  }

  // Upgrade the smallest servers toward the cap.
  for (;;) {
    const smallest = ns.cloud
      .getServerNames()
      .map((h) => ({ h, ram: ns.getServerMaxRam(h) }))
      .filter((s) => s.ram < ramLimit)
      .sort((a, b) => a.ram - b.ram)[0];
    if (!smallest) break;
    const next = smallest.ram * 2;
    const cost = ns.cloud.getServerUpgradeCost(smallest.h, next);
    if (cost > left) break;
    if (!ns.cloud.upgradeServer(smallest.h, next)) break;
    left -= cost;
    upgraded.push(`${smallest.h} -> ${ns.format.ram(next)}`);
  }

  return { bought, upgraded, spent: budget - left };
}

/** Total RAM across all purchased servers. */
export function purchasedRam(ns: NS): number {
  return ns.cloud.getServerNames().reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);
}
