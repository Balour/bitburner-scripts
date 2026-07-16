import type { NS } from '@ns';
import { CLASH_DISENGAGE_FLOOR, CLASH_ENGAGE_FLOOR, POWER_RELEASE_FLOOR, npcPowerRate } from '../lib/gang';
import { PORT_GANG, PORT_GANG_BUILD } from '../lib/ports';

/**
 * ~11.6 GB. Short-lived — exec'd round-robin by the gang controller, then exits. It owns the two
 * calls the controller can't afford to hold resident: getChanceToWinClash (4 GB) and
 * getAllGangInformation (2 GB).
 *
 * Losing a clash can kill a member, so clashes stay OFF until we can beat EVERY live rival, not
 * just the average one. That matters more than usual here: NPC gangs grow power passively on a
 * faction-keyed multiplier (src/Gang/data/power.ts), and both 5x-growth gangs — Speakers for the
 * Dead and The Black Hand — are still in the pool when we found with Slum Snakes (1x).
 *
 * The engage/disengage floors differ on purpose: hysteresis, so we don't flap at the boundary.
 *
 * Publishes `{ engaged, minChance, rivalPower, rivalRate }` on PORT_GANG. It does NOT decide
 * whether to staff warfare: that needs member stats (power is stats/95), which live in the
 * controller. We publish the rival half of the race — power and its passive growth — and the
 * controller compares it against its own roster.
 *
 * Run: `run /gang/territory.js`
 */
export async function main(ns: NS) {
  ns.disableLog('ALL');

  const info = ns.gang.getGangInformation();
  const all = ns.gang.getAllGangInformation();

  // A gang with no territory left is out of the fight and can't be clashed.
  const rivals = Object.keys(all).filter((name) => name !== info.faction && all[name].territory > 0);
  const chances = rivals.map((name) => ns.gang.getChanceToWinClash(name));
  const minChance = chances.length > 0 ? Math.min(...chances) : 1;

  // The gang we're actually racing is the one we're worst against — beat it and the rest follow.
  const worst = chances.length > 0 ? rivals[chances.indexOf(minChance)] : undefined;
  const rivalPower = worst ? all[worst].power : 0;
  const rivalRate = worst ? npcPowerRate(worst, all[worst].power, all[worst].territory) : 0;

  // Never START a war we aren't investing in. A fresh BitNode hands every gang power 1 and territory
  // 1/7, so minChance reads exactly 0.5 against everyone from the first tick — clearing the engage
  // floor before we have a roster, let alone one on Territory Warfare. Require that the controller
  // is building power (or that we already dominate, which is how we stay engaged after it stands the
  // roster down at POWER_RELEASE_FLOOR). Disengaging stays governed by the chance floor alone, so a
  // war we're losing always ends.
  const building = ns.peek(PORT_GANG_BUILD) === '1';
  const canStart = building || minChance >= POWER_RELEASE_FLOOR;

  const wasEngaged = info.territoryWarfareEngaged;
  const engaged = wasEngaged ? minChance >= CLASH_DISENGAGE_FLOOR : canStart && minChance >= CLASH_ENGAGE_FLOOR;

  if (engaged !== wasEngaged) {
    ns.gang.setTerritoryWarfare(engaged);
    ns.print(`clashes ${engaged ? 'ENGAGED' : 'disengaged'} — worst matchup ${ns.format.percent(minChance)}`);
  }

  ns.clearPort(PORT_GANG);
  ns.writePort(PORT_GANG, JSON.stringify({ engaged, minChance, rivalPower, rivalRate }));
}
