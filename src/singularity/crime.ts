import type { NS } from '@ns';
import type { Strategy } from '../lib/strategy';
import type { Sing } from './api';

/**
 * P1 crime logic: one action per call toward the karma target. Ramps combat at the gym (funded by
 * crime) until Homicide is reliable, then grinds the karma-optimal crime. Self-corrects after an
 * augment install resets combat stats — Homicide's chance drops, so it falls back to the gym on its own.
 *
 * The controller owns the single player action slot and calls this in a loop; each call starts one
 * action and awaits its duration. All Singularity calls come in bracket-hidden via `Sing`.
 */

/** One action's outcome, for the controller's log/record. */
export interface CrimeStep {
  action: 'seed' | 'gym' | 'crime';
  detail: string;
  sleptMs: number;
  /** True if the player took focus mid-action — we stopped our action and the controller should back off. */
  yielded: boolean;
}

/**
 * Sleep `ms` while an action runs, watching for the PLAYER to take focus. We commit focused, so while our
 * action runs `isFocused()` is true; if it drops, the player navigated away / took over — stop our action
 * (freeing the slot) and report a yield. Skips the first poll (let focus register) and stops polling ~600ms
 * before the end (so an action completing naturally isn't misread as the player taking focus).
 */
async function sleepWatchingFocus(ns: NS, s: Sing, ms: number): Promise<boolean> {
  let slept = 0;
  while (slept < ms - 600) {
    await ns.sleep(500);
    slept += 500;
    if (slept > 500 && !s['isFocused']()) {
      s['stopAction']();
      return true;
    }
  }
  if (slept < ms) await ns.sleep(ms - slept);
  return false;
}

/** Verified karma + duration (bitburner-src Crimes.ts). Homicide is the karma engine — ~16× Mug's
 * karma/sec at equal success — but hard early (difficulty 1). Mug is the reliable early money crime.
 * Re-verify if the game rebalances crimes. */
const CANDIDATES: { key: 'homicide' | 'mug'; karma: number; sec: number }[] = [
  { key: 'homicide', karma: 3, sec: 3 },
  { key: 'mug', karma: 0.25, sec: 4 },
];

/** Below this cash, do a quick money crime to fund the gym rather than train broke. */
const GYM_FUND_FLOOR = 500_000;
/** Train this long between re-checks of Homicide chance. */
const GYM_TICK_MS = 20_000;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** The karma-optimal crime right now: max(karma × successChance / seconds). Almost always Homicide once
 * its chance clears ~7%; Mug wins only at very low combat stats. */
function bestKarmaCrime(ns: NS, s: Sing): { name: string; chance: number } {
  const nameOf = (k: 'homicide' | 'mug') => (k === 'homicide' ? ns.enums.CrimeType.homicide : ns.enums.CrimeType.mug);
  let best = { name: nameOf('homicide'), chance: 0, score: -1 };
  for (const c of CANDIDATES) {
    const cname = nameOf(c.key);
    const chance = s['getCrimeChance'](cname);
    const score = (c.karma * chance) / c.sec;
    if (score > best.score) best = { name: cname, chance, score };
  }
  return { name: best.name, chance: best.chance };
}

export async function crimeStep(ns: NS, s: Sing, strat: Strategy): Promise<CrimeStep> {
  const p = ns.getPlayer();
  const str = p.skills.strength;
  const def = p.skills.defense;
  const homChance = s['getCrimeChance'](ns.enums.CrimeType.homicide);

  const ramping = homChance < strat.crime.homicideChanceSwitch && Math.min(str, def) < strat.crime.gymStatTarget;

  // Broke while ramping: a quick reliable money crime to fund the gym (also trains combat, drips karma).
  if (ramping && p.money < GYM_FUND_FLOOR) {
    const dur = s['commitCrime'](ns.enums.CrimeType.mug, true);
    const yielded = await sleepWatchingFocus(ns, s, dur + 50);
    return { action: 'seed', detail: `Mug for gym funds (str ${str} def ${def})`, sleptMs: dur + 50, yielded };
  }

  // Ramp: train the lower of STR/DEF — Homicide's weight-2 stats, steepest chance-per-level.
  if (ramping) {
    if (p.city !== ns.enums.CityName.Sector12) s['travelToCity'](ns.enums.CityName.Sector12);
    const stat = str <= def ? ns.enums.GymType.strength : ns.enums.GymType.defense;
    s['gymWorkout'](ns.enums.LocationName.Sector12PowerhouseGym, stat, true);
    const yielded = await sleepWatchingFocus(ns, s, GYM_TICK_MS);
    return {
      action: 'gym',
      detail: `train ${stat} (str ${str} def ${def}, hom ${pct(homChance)})`,
      sleptMs: GYM_TICK_MS,
      yielded,
    };
  }

  // Grind: the karma-optimal crime (Homicide once viable).
  const best = bestKarmaCrime(ns, s);
  const dur = s['commitCrime'](best.name, true);
  const yielded = await sleepWatchingFocus(ns, s, dur + 50);
  return { action: 'crime', detail: `${best.name} (hom ${pct(homChance)})`, sleptMs: dur + 50, yielded };
}
