import type { NS } from '@ns';
import type { Target } from './types';
import { PORT_RANK, TARGETS_FILE } from './ports';

/**
 * Shared, NS-free glue for the two rank front-ends (rank.ts, the ratio-projection
 * fallback, and rank-formulas.ts, the Formulas.exe path). Both measure each host
 * their own way, then hand the primitives here for identical scoring, printing and
 * publishing — so the `Target[]` contract the daemon consumes is byte-for-byte the
 * same regardless of which front-end produced it.
 *
 * Touches ONLY free (0 GB) NS surface — ns.format.*, port I/O, ns.write, ns.tprint —
 * so importing it drags no RAM cost into either rank file. Keep it that way.
 */

/** One host's measurements, already projected to min security by the caller. */
export interface Measured {
  host: string;
  maxMoney: number;
  reqSkill: number;
  baseSec: number;
  minSec: number;
  /** Actual security when measured, for display only. */
  curSec: number;
  pctAtMin: number;
  chanceAtMin: number;
  hackTimeAtMin: number;
  /** Threads to regrow one batch back to max. */
  growThreads: number;
}

/**
 * Score one host's measurements into a Target. Pure arithmetic — 0 GB.
 *
 * weaken/grow times are the fixed 3.2x/4x multiples of hack time (real game
 * constants), so security deltas per op follow from hackTimeAtMin alone.
 */
export function scoreTarget(level: number, m: Measured): Target {
  const weakenSecAtMin = (4 * m.hackTimeAtMin) / 1000;
  const growSecAtMin = (3.2 * m.hackTimeAtMin) / 1000;

  // hack() hard-requires level >= reqSkill, on top of the chance roll.
  const moneyScore = level < m.reqSkill ? 0 : (m.maxMoney * m.pctAtMin * m.chanceAtMin) / weakenSecAtMin;
  // grow/weaken have no level gate at all, and exp scales with BASE security.
  const xpScore = (3 + m.baseSec * 0.3) / growSecAtMin;

  return {
    host: m.host,
    maxMoney: m.maxMoney,
    reqSkill: m.reqSkill,
    baseSec: m.baseSec,
    minSec: m.minSec,
    curSec: m.curSec,
    pctAtMin: m.pctAtMin,
    chanceAtMin: m.chanceAtMin,
    hackTimeAtMin: m.hackTimeAtMin,
    moneyScore,
    xpScore,
    growThreads: m.growThreads,
  };
}

function table(ns: NS, title: string, rows: Target[], score: (t: Target) => string) {
  ns.tprint('');
  ns.tprint(`  ${title}`);
  ns.tprint(
    `  ${'host'.padEnd(18)} ${'score'.padStart(12)} ${'lvl'.padStart(5)}  ${'max $'.padStart(9)}  sec  chance  grow/batch`,
  );
  for (const row of rows.slice(0, 10)) {
    ns.tprint(
      `  ${row.host.padEnd(18)} ${score(row).padStart(12)} ${String(row.reqSkill).padStart(5)}  ` +
        `${ns.format.number(row.maxMoney).padStart(9)}  ${row.minSec.toFixed(0).padStart(3)}  ` +
        `${ns.format.percent(row.chanceAtMin, 0).padStart(6)}  ${String(row.growThreads).padStart(10)}`,
    );
  }
}

/** Print the money and xp tables to the terminal. Free NS only. */
export function printTables(ns: NS, targets: Target[], level: number) {
  const byMoney = [...targets].filter((t) => t.moneyScore > 0).sort((a, b) => b.moneyScore - a.moneyScore);
  const byXp = [...targets].sort((a, b) => b.xpScore - a.xpScore);

  ns.tprint('');
  ns.tprint(`=== rank (hacking ${level}, projected to min security) ===`);

  if (byMoney.length === 0) {
    ns.tprint('');
    ns.tprint(`  No hackable target yet — every rooted server needs a higher hacking level.`);
    ns.tprint(`  Grow/weaken still work everywhere, so the XP table below is what matters.`);
  } else {
    table(ns, `money — $/sec per hack thread, fully prepped`, byMoney, (t) => ns.format.number(t.moneyScore));
  }
  table(ns, 'xp — hacking exp/sec per grow thread (no level gate)', byXp, (t) => t.xpScore.toFixed(4));
  ns.tprint('');
}

/**
 * Publish the Target[] to the daemon (port, free and global across hosts) and to a
 * file on whichever host this ran on (for humans + monitor.js). All 0 GB.
 */
export function publish(ns: NS, targets: Target[]) {
  ns.clearPort(PORT_RANK);
  ns.writePort(PORT_RANK, JSON.stringify(targets));
  ns.write(TARGETS_FILE, JSON.stringify(targets, null, 2), 'w');
}
