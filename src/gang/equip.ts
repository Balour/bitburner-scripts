import type { NS } from '@ns';
import { GANG_CASH_RESERVE, GEAR_BUDGET_FRACTION } from '../lib/gang';

/**
 * ~16.7 GB. Short-lived — exec'd round-robin by the gang controller, then exits.
 *
 * Every purchase leaves at least GANG_CASH_RESERVE untouched, so the gang never spends the cash
 * your personal hacking-augment batches need (that grind to hacking 15k is the actual way out).
 *
 * Above that reserve, two tiers by durability, because `GangMember.ascend()` does
 * `this.upgrades.length = 0` then re-applies `this.augmentations`:
 *
 *   - **Augmentations survive ascension AND install** → the durable buy. Funded FIRST, cheapest
 *     across the roster, limited only by the reserve. This is what soaks up idle cash: gear is far
 *     too cheap to (a fully kitted roster is only tens of millions).
 *   - **Equipment is destroyed on every ascension** → funded second, and additionally capped at
 *     GEAR_BUDGET_FRACTION of cash per item, so the churn during the ascension phase stays cheap.
 *
 * Money is re-read before every purchase, so the reserve check self-limits without any batching.
 *
 * Run: `run /gang/equip.js`
 */
export async function main(ns: NS) {
  ns.disableLog('ALL');

  // Buy only what this gang's tasks actually weight. A combat gang uses str/def/dex/agi/cha; a
  // hacking gang uses hack/cha (cha matters to both). Everything else is money for nothing — e.g.
  // BitWire's +5% hacking, or a hack-only rootkit, on a combat gang. Territory power sums ALL
  // stats, but the off-type augs cost billions for a 1.05-1.15x mult, so they're never worth it.
  // Read from the live API so a hacking gang filters the mirror image with no code change.
  const relevant = ns.gang.getGangInformation().isHacking ? ['hack', 'cha'] : ['str', 'def', 'dex', 'agi', 'cha'];
  const boostsRelevant = (stats: Record<string, number | undefined>): boolean =>
    relevant.some((stat) => (stats[stat] ?? 1) > 1);

  // getEquipmentCost already folds in the gang's equipmentCostMult discount.
  const catalogue = ns.gang
    .getEquipmentNames()
    .map((name) => ({
      name,
      cost: ns.gang.getEquipmentCost(name),
      isAug: ns.gang.getEquipmentType(name) === 'Augmentation',
      stats: ns.gang.getEquipmentStats(name) as Record<string, number | undefined>,
    }))
    .filter((item) => Number.isFinite(item.cost) && boostsRelevant(item.stats))
    .sort((a, b) => a.cost - b.cost);

  const members = ns.gang.getMemberNames().map((name) => ns.gang.getMemberInformation(name));

  // Durable augs before disposable gear; cheapest first within each so the whole roster gets the
  // basics before anyone gets a luxury.
  const ordered = [...catalogue.filter((i) => i.isAug), ...catalogue.filter((i) => !i.isAug)];

  let bought = 0;
  let spent = 0;
  for (const item of ordered) {
    for (const member of members) {
      const owned = item.isAug ? member.augmentations : member.upgrades;
      if (owned.includes(item.name)) continue;

      const money = ns.getServerMoneyAvailable('home');
      if (money - item.cost < GANG_CASH_RESERVE) continue; // protect the personal-augment reserve
      if (!item.isAug && item.cost > money * GEAR_BUDGET_FRACTION) continue; // gear churns — keep it modest

      if (ns.gang.purchaseEquipment(member.name, item.name)) {
        bought++;
        spent += item.cost;
      }
    }
  }

  if (bought > 0) ns.print(`bought ${bought} item(s) for ${ns.format.number(spent)}`);
}
