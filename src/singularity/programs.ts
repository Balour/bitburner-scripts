import type { NS } from '@ns';
import { crawl } from '../lib/net';
import { strategyFor } from '../lib/strategy';
import { sing, reserveOk } from './api';

/**
 * P0 program acquisition (Singularity). Buys the TOR router, then the port openers and Formulas.exe from
 * the darkweb. One-shot and idempotent — re-run any time; it skips what you already own and can't afford.
 *
 * Openers are LEVEL-GATED WHILE POOR: each is bought only once our hacking level reaches the lowest-level
 * host it unlocks, so a cash-poor run doesn't pay $250M for SQLInject before it can hack any 5-port server.
 * Cheap openers pass the gate early since their hosts are low-level; the gate really only defers HTTPWorm
 * and SQLInject. Formulas.exe ($5B) is surplus-only.
 *
 * ABOVE `strat.programs.richCash` THE GATE IS SKIPPED, because it is a money-conservation heuristic and
 * money has stopped being the constraint. It is also actively costing us at that point: `nuke` checks port
 * requirements ONLY, never hacking level, so owning SQLInject at hacking 1 roots all 29 five-port servers
 * for their RAM immediately. That matters most right after an install, which wipes every program and
 * purchased server while the gang earns straight through — so the pool comes back as fast as we re-buy.
 *
 * Run: `run /singularity/programs.js`            buy everything gated + affordable
 *      `run /singularity/programs.js --no-root`  don't exec root.js after buying an opener
 */
const REV = 'v3';

/** Openers with the port count they unlock — port order is also cost order (cheapest first). */
const OPENERS = [
  { file: 'BruteSSH.exe', ports: 1 },
  { file: 'FTPCrack.exe', ports: 2 },
  { file: 'relaySMTP.exe', ports: 3 },
  { file: 'HTTPWorm.exe', ports: 4 },
  { file: 'SQLInject.exe', ports: 5 },
];
const FORMULAS = 'Formulas.exe';

/** Keep this much liquid when buying the pricey Formulas.exe, so a $5B buy never drains the run. */
const FORMULAS_RESERVE = 2e9;

export async function main(ns: NS) {
  const flags = ns.flags([['no-root', false]]);
  const autoRoot = !flags['no-root'];

  // Cover the bracket-hidden Singularity calls (purchaseTor 2, purchaseProgram 2, getDarkwebProgramCost
  // 0.5, getDarkwebPrograms 1) plus a re-root exec (1.3) and getResetInfo (1). ×1 inside BN4; clamped to
  // the host's RAM.
  if (!reserveOk(ns, 16, 11)) return;
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);
  /** Money has stopped being the constraint — buy openers on sight, ignoring the hacking-level gate. */
  const rich = ns.getServerMoneyAvailable('home') >= strat.programs.richCash;

  ns.tprint('');
  ns.tprint(`=== programs ${REV} ===`);

  // TOR first — nothing on the darkweb is buyable without it. hasTorRouter is a cheap top-level call.
  if (!ns.hasTorRouter()) {
    if (s['purchaseTor']()) ns.tprint('  bought: TOR router');
    else {
      ns.tprint(
        `  no TOR yet — need $200k, have ${ns.format.number(ns.getServerMoneyAvailable('home'))}. Nothing to buy.`,
      );
      return;
    }
  }

  const bought: string[] = [];
  let boughtOpener = false;

  // Lowest required hacking level among UN-ROOTED hosts needing AT LEAST `ports` ports (Infinity if none).
  // `>=` not `===`: a host needing K ports needs every opener 1..K, so it justifies buying opener N whenever
  // K >= N. This matters at the endgame — w0r1d_d43m0n (5 ports) is often the only un-rooted host left, and an
  // exact-match gate would then refuse to re-buy the cheaper openers it still needs to root the daemon.
  const hosts = crawl(ns);
  const level = ns.getHackingLevel();
  const minLevelForPorts = (ports: number): number => {
    let min = Infinity;
    for (const h of hosts) {
      if (h === 'home' || ns.hasRootAccess(h)) continue;
      if (ns.getServerNumPortsRequired(h) >= ports) min = Math.min(min, ns.getServerRequiredHackingLevel(h));
    }
    return min;
  };

  // Cheapest(=fewest-ports)-first, each gated on our level reaching the lowest host it unlocks.
  for (const { file, ports } of OPENERS) {
    if (ns.fileExists(file, 'home')) continue;
    const cost = s['getDarkwebProgramCost'](file);
    if (cost <= 0) continue; // unavailable

    // The level gate is skipped outright when rich — see the header. Note this also sidesteps the
    // `need === Infinity` case (every host this opener would unlock is already rooted), which would
    // otherwise gate the opener forever since `level < Infinity` is always true.
    const need = rich ? 0 : minLevelForPorts(ports);
    if (level < need) {
      ns.tprint(
        `  gate:   ${file.padEnd(14)} — hacking ${level} < ${need === Infinity ? 'n/a' : need} (lowest ${ports}-port host)`,
      );
      continue;
    }
    if (ns.getServerMoneyAvailable('home') < cost) {
      ns.tprint(`  skip:   ${file.padEnd(14)} — costs ${ns.format.number(cost)}, not enough cash`);
      continue;
    }
    if (s['purchaseProgram'](file)) {
      bought.push(file);
      boughtOpener = true;
      ns.tprint(
        `  bought: ${file.padEnd(14)} (${ns.format.number(cost)}) — unlocks ${ports}-port hosts${rich ? ' [rich: level gate skipped]' : ''}`,
      );
    }
  }

  // Formulas.exe: surplus-only.
  if (!ns.fileExists(FORMULAS, 'home')) {
    const cost = s['getDarkwebProgramCost'](FORMULAS);
    if (cost > 0 && ns.getServerMoneyAvailable('home') - cost >= FORMULAS_RESERVE) {
      if (s['purchaseProgram'](FORMULAS)) {
        bought.push(FORMULAS);
        ns.tprint(`  bought: ${FORMULAS} (${ns.format.number(cost)}) — daemon can switch to rank-formulas`);
      }
    } else if (cost > 0) {
      ns.tprint(`  hold:   ${FORMULAS} — ${ns.format.number(cost)}, waiting for surplus over reserve`);
    }
  }

  ns.tprint(bought.length ? `  done — bought ${bought.length}` : '  done — nothing to buy (owned or unaffordable)');

  // A newly-bought opener (esp. SQLInject) roots more servers immediately — re-run root.js rather than
  // wait for the daemon's 5-min re-rank. root.ts already picks up the new opener via fileExists.
  if (boughtOpener && autoRoot) {
    ns.exec('/root.js', 'home');
    ns.tprint('  re-ran root.js to nuke newly-reachable servers');
  }
  ns.tprint('');
}
