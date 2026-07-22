import type { NS } from '@ns';
import { PORT_SING_PAUSE } from '../lib/ports';
import { sing, reserveOk } from './api';

/**
 * P2 crime-for-money (Singularity), PERSISTENT. Commits the best money crime on a loop while cash is low —
 * bridges the early-gang ramp and the post-aug-install cash drought, when the gang isn't earning yet and
 * the action slot would otherwise idle. The controller launches this when money is below its floor and
 * kills it once the gang provides. Picks by money × success-chance / time, so it self-upgrades Mug → Homicide
 * as crime trains combat back up. focus=false so it doesn't hijack the screen; honors PORT_SING_PAUSE.
 *
 * Run: `run /singularity/crime-money.js`
 */
const REV = 'v1';

/** Verified base money + duration (BN4's 0.2× CrimeMoney is uniform, so it doesn't change the ranking). */
const CANDIDATES: { key: 'mug' | 'homicide'; money: number; sec: number }[] = [
  { key: 'mug', money: 36_000, sec: 4 },
  { key: 'homicide', money: 45_000, sec: 3 },
];

export async function main(ns: NS) {
  ns.disableLog('ALL');
  if (!reserveOk(ns, 16, 12)) return;
  const s = sing(ns);
  const nameOf = (k: 'mug' | 'homicide') => (k === 'homicide' ? ns.enums.CrimeType.homicide : ns.enums.CrimeType.mug);

  ns.print(`crime-money ${REV} — earning cash while the gang ramps`);
  while (true) {
    const paused = ns.peek(PORT_SING_PAUSE);
    if (paused === '1' || paused === 1) {
      await ns.sleep(1000);
      continue;
    }
    let best = { name: nameOf('mug'), score: -1 };
    for (const c of CANDIDATES) {
      const cn = nameOf(c.key);
      const score = (c.money * s['getCrimeChance'](cn)) / c.sec;
      if (score > best.score) best = { name: cn, score };
    }
    const dur = s['commitCrime'](best.name, false);
    await ns.sleep(dur + 50);
  }
}
