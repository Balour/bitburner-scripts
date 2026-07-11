import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { GROW_MULT, PORT_RANK, TARGETS_FILE } from './lib/ports';

/**
 * 5.45 GB. Ranks every rooted server two ways, without Formulas.exe.
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

    const weakenSecAtMin = (4 * hackTimeAtMin) / 1000;
    const growSecAtMin = (3.2 * hackTimeAtMin) / 1000;

    // hack() hard-requires level >= reqSkill, on top of the chance roll.
    const moneyScore = level < reqSkill ? 0 : (maxMoney * pctAtMin * chanceAtMin) / weakenSecAtMin;

    // grow/weaken have no level gate at all, and exp scales with BASE security.
    const xpScore = (3 + baseSec * 0.3) / growSecAtMin;

    // Grow threads for one batch. growthAnalyze measures at CURRENT security, so
    // this over-estimates while a server is unprepped (safe: grow caps at max)
    // and is exact once the daemon re-ranks with the server at min security.
    const growThreads = Math.ceil(ns.growthAnalyze(host, GROW_MULT));

    targets.push({
      host,
      maxMoney,
      reqSkill,
      baseSec,
      minSec,
      curSec,
      pctAtMin,
      chanceAtMin,
      hackTimeAtMin,
      moneyScore,
      xpScore,
      growThreads,
    });
  }
  return targets;
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

export async function main(ns: NS) {
  const targets = rankAll(ns);
  const level = ns.getHackingLevel();

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

  // Free: port I/O is 0 GB and global across hosts, so this reaches daemon.js on
  // home even when rank.js is exec'd on a remote 16 GB server.
  ns.clearPort(PORT_RANK);
  ns.writePort(PORT_RANK, JSON.stringify(targets));

  // ns.write lands on whichever host this ran on; daemon.js writes home's copy.
  ns.write(TARGETS_FILE, JSON.stringify(targets, null, 2), 'w');
  ns.tprint('');
}
