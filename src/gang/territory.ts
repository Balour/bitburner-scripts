import type { NS } from '@ns';
import { CLASH_DISENGAGE_FLOOR, CLASH_ENGAGE_FLOOR } from '../lib/gang';
import { PORT_GANG } from '../lib/ports';

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
 * Publishes `{ wantPower, engaged, minChance }` on PORT_GANG. The controller reads it to decide
 * how many members to park on Territory Warfare — power only accrues from members on that task.
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

  const wasEngaged = info.territoryWarfareEngaged;
  const engaged = wasEngaged ? minChance >= CLASH_DISENGAGE_FLOOR : minChance >= CLASH_ENGAGE_FLOOR;

  if (engaged !== wasEngaged) {
    ns.gang.setTerritoryWarfare(engaged);
    ns.print(`clashes ${engaged ? 'ENGAGED' : 'disengaged'} — worst matchup ${ns.format.percent(minChance)}`);
  }

  ns.clearPort(PORT_GANG);
  ns.writePort(PORT_GANG, JSON.stringify({ wantPower: !engaged, engaged, minChance }));
}
