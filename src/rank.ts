import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { printTables, publish, scoreTarget } from './lib/rank-core';
import { GROW_MULT } from './lib/ports';

/**
 * 5.45 GB. Ranks every rooted server two ways, WITHOUT Formulas.exe — the fallback
 * used whenever Formulas.exe is absent (e.g. the window after every augment install,
 * before it is re-bought). rank-formulas.ts is the exact-math path; the daemon picks
 * between them at runtime. Both emit an identical Target[] via lib/rank-core.
 *
 * THE SUBSTITUTE FOR FORMULAS.EXE
 * -------------------------------
 * Formulas.exe ($5B) is what normally lets you evaluate a *hypothetical* server
 * state. We do not need it, because security enters the three relevant formulas
 * through exactly one term each, and everything else cancels in a ratio:
 *
 *   percentMoneyHacked = difficultyMult * skillMult * mults / 240
 *   hackChance         = skillChance * difficultyMult * mults * intBonus
 *      ...where difficultyMult = (100 - sec) / 100        -> linear in sec
 *
 *   hackTime = 5 * (2.5 * reqSkill * sec + 500) / (hacking + 50) / mults
 *      ...the only sec term is (2.5 * reqSkill * sec + 500)
 *
 * The skill terms, player multipliers, intelligence bonus and BitNode
 * multipliers are all security-independent, so measuring at CURRENT security
 * with the cheap live calls and rescaling to MIN security is exact — no
 * assumptions about mults, no hardcoded BitNode values.
 *
 * `growTime` and `weakenTime` are fixed multiples of `hackTime` (3.2x and 4x),
 * so one `getHackTime` call (0.05 GB) yields all three.
 *
 * Run: `run /rank.js`   (or exec'd on a 16 GB host by daemon.js)
 */

/** Security thresholds where the projection degenerates. */
const SEC_CEILING = 99;

export function rankAll(ns: NS): Target[] {
  const level = ns.getHackingLevel();
  const targets: Target[] = [];

  for (const host of rooted(ns, crawl(ns))) {
    if (host === 'home') continue;

    const maxMoney = ns.getServerMaxMoney(host);
    if (maxMoney <= 0) continue;

    const curSec = ns.getServerSecurityLevel(host);
    // Guard: (100 - curSec) hits zero or goes negative, and hackAnalyzeChance
    // already returns 0 at difficulty >= 100. Both poison the ratio.
    if (curSec >= SEC_CEILING) continue;

    const minSec = ns.getServerMinSecurityLevel(host);
    const baseSec = ns.getServerBaseSecurityLevel(host);
    const reqSkill = ns.getServerRequiredHackingLevel(host);

    const ratio = (100 - minSec) / (100 - curSec);
    const pctAtMin = ns.hackAnalyze(host) * ratio;
    const chanceAtMin = Math.min(1, Math.max(0, ns.hackAnalyzeChance(host) * ratio));
    const hackTimeAtMin = ns.getHackTime(host) * ((2.5 * reqSkill * minSec + 500) / (2.5 * reqSkill * curSec + 500));

    // Grow threads for one batch. growthAnalyze measures at CURRENT security, so
    // this over-estimates while a server is unprepped (safe: grow caps at max)
    // and is exact once the daemon re-ranks with the server at min security.
    const growThreads = Math.ceil(ns.growthAnalyze(host, GROW_MULT));

    targets.push(
      scoreTarget(level, {
        host,
        maxMoney,
        reqSkill,
        baseSec,
        minSec,
        curSec,
        pctAtMin,
        chanceAtMin,
        hackTimeAtMin,
        growThreads,
      }),
    );
  }
  return targets;
}

export async function main(ns: NS) {
  const targets = rankAll(ns);
  printTables(ns, targets, ns.getHackingLevel());
  publish(ns, targets);
}
