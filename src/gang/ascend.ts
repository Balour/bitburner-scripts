import type { NS } from '@ns';
import { ASCEND_THRESHOLD } from '../lib/gang';

/**
 * ~8.7 GB. Short-lived — the gang controller execs it round-robin, it works, it exits.
 * Lives apart from the controller because ascendMember alone is 4 GB.
 *
 * Ascension resets a member's stats and exp, and refunds nothing: it deducts every point of
 * respect that member has earned since their last ascension. In exchange their permanent stat
 * multipliers grow. So we only pull the trigger past a threshold gain, never reflexively.
 *
 * NOTE for equip.js: ascend() does `this.upgrades.length = 0` — equipment is DESTROYED here.
 * Augmentations are re-applied and survive.
 *
 * Run: `run /gang/ascend.js`
 */
export async function main(ns: NS) {
  ns.disableLog('ALL');

  for (const name of ns.gang.getMemberNames()) {
    const result = ns.gang.getAscensionResult(name);
    if (!result) continue;

    // Factors are newMult/oldMult per stat. Take the best across all six rather than assuming a
    // combat gang — a hacking gang would want the hack factor to count.
    const gain = Math.max(result.hack, result.str, result.def, result.dex, result.agi, result.cha);
    if (gain < ASCEND_THRESHOLD) continue;

    ns.gang.ascendMember(name);
    ns.print(`ascended ${name} — ${ns.format.number(gain)}x, -${ns.format.number(result.respect)} respect`);
  }
}
