import type { NS } from '@ns';
import { strategyFor } from '../lib/strategy';
import { sing, reserve } from './api';

/**
 * P2 augment buyer (Singularity), one-shot. Buys every affordable augment we have the rep + prereqs for,
 * across all joined factions, MOST-EXPENSIVE-FIRST so the 1.9× per-queued-aug escalation lands on the
 * cheap ones. Then dumps surplus into NeuroFlux Governor levels. Keeps `strat.augs.cashReserve` liquid.
 *
 * Instant calls (no action slot). UNVERIFIED in-game — validate before trusting the reset loop.
 *
 * Run: `run /singularity/augs.js`
 */
const REV = 'v1';
const NFG = 'NeuroFlux Governor';

export async function main(ns: NS) {
  reserve(ns, 40);
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);
  const money = () => ns.getServerMoneyAvailable('home');

  const owned = new Set(s['getOwnedAugmentations'](true)); // includes purchased-but-not-installed (queued)
  const factions = ns.getPlayer().factions;

  // Buyable = rep met + prereqs owned + not already owned/queued. Dedupe an aug offered by many factions.
  type Buy = { faction: string; aug: string; price: number };
  const buyable: Buy[] = [];
  for (const f of factions) {
    const rep = s['getFactionRep'](f);
    for (const aug of s['getAugmentationsFromFaction'](f)) {
      if (aug === NFG || owned.has(aug) || buyable.some((b) => b.aug === aug)) continue;
      if (rep < s['getAugmentationRepReq'](aug)) continue;
      if (!s['getAugmentationPrereq'](aug).every((p) => owned.has(p))) continue;
      buyable.push({ faction: f, aug, price: s['getAugmentationPrice'](aug) });
    }
  }
  buyable.sort((a, b) => b.price - a.price);

  const bought: string[] = [];
  for (const b of buyable) {
    // Re-fetch the live price: earlier buys raise the escalation for later ones.
    const price = s['getAugmentationPrice'](b.aug);
    if (money() - price < strat.augs.cashReserve) continue;
    if (s['purchaseAugmentation'](b.faction, b.aug)) {
      owned.add(b.aug);
      bought.push(b.aug);
      ns.tprint(`  bought: ${b.aug} from ${b.faction} (${ns.format.number(price)})`);
    }
  }

  // NeuroFlux dump: buy from the highest-rep faction that still sells it, while affordable. Its rep
  // requirement and price both climb per purchase, so re-evaluate each iteration.
  let nfg = 0;
  if (strat.augs.neuroFluxDump) {
    for (;;) {
      const seller = factions
        .filter(
          (f) =>
            s['getAugmentationsFromFaction'](f).includes(NFG) &&
            s['getFactionRep'](f) >= s['getAugmentationRepReq'](NFG),
        )
        .sort((a, b) => s['getFactionRep'](b) - s['getFactionRep'](a))[0];
      if (!seller) break;
      if (money() - s['getAugmentationPrice'](NFG) < strat.augs.cashReserve) break;
      if (!s['purchaseAugmentation'](seller, NFG)) break;
      nfg++;
    }
  }

  ns.tprint(`=== augs ${REV} — bought ${bought.length} aug(s) + ${nfg}× ${NFG} ===`);
}
