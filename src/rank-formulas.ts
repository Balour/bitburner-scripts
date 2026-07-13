import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { printTables, publish, scoreTarget } from './lib/rank-core';
import { HACK_FRACTION } from './lib/ports';

/**
 * ~4.4 GB. The Formulas.exe path — exact-math counterpart to rank.ts. Emits an
 * identical Target[] via lib/rank-core, so the daemon consumes it unchanged; the
 * daemon execs THIS file instead of rank.js whenever Formulas.exe exists on home,
 * and falls back to rank.js otherwise (there is a window with no Formulas.exe after
 * every augment install, until it is re-bought).
 *
 * Why it exists as a separate file: `ns.formulas.*` calls are 0 GB, but feeding them
 * needs getServer (2 GB) + getPlayer (0.5 GB). Merging both paths into one file would
 * make the static parser charge BOTH branches' NS surface (~8 GB) — dead references
 * still cost — so we split and pick the file at exec time.
 *
 * What Formulas buys over the ratio fallback: pctAtMin/chanceAtMin/hackTimeAtMin are
 * already exact in rank.ts, so those match. The real gain is EXACT, core-aware grow
 * threads — growThreads() computes the precise regrow of one HACK_FRACTION steal at
 * min security, replacing rank.ts's growthAnalyze x GROW_MULT=1.5 padding.
 *
 * Run: `run /rank-formulas.js`   (or exec'd on a 16 GB host by daemon.js)
 */

export function rankAll(ns: NS): Target[] {
  const level = ns.getHackingLevel();
  const player = ns.getPlayer();
  const f = ns.formulas.hacking;
  const targets: Target[] = [];

  for (const host of rooted(ns, crawl(ns))) {
    if (host === 'home') continue;

    const srv = ns.getServer(host);
    const maxMoney = srv.moneyMax ?? 0;
    if (maxMoney <= 0) continue;

    const minSec = srv.minDifficulty ?? 1;
    const curSec = srv.hackDifficulty ?? minSec;
    const baseSec = srv.baseDifficulty ?? minSec;
    const reqSkill = srv.requiredHackingSkill ?? 1;

    // Project to min security + full money for the hack metrics. formulas read the
    // server object we pass, so mutating the mock is how we evaluate a hypothetical.
    srv.hackDifficulty = minSec;
    srv.moneyAvailable = maxMoney;
    const pctAtMin = f.hackPercent(srv, player);
    const chanceAtMin = f.hackChance(srv, player);
    const hackTimeAtMin = f.hackTime(srv, player);

    // Exact grow threads to regrow one batch: from post-hack money back to max, at
    // min security. cores = 1 deliberately — most grows land on 1-core pool servers;
    // assuming 1 only over-provisions the minority run on multi-core home, which is
    // safe (grow caps at max).
    srv.moneyAvailable = maxMoney * (1 - HACK_FRACTION);
    const growThreads = f.growThreads(srv, player, maxMoney, 1);

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
