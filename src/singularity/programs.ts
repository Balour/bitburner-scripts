import type { NS } from '@ns';
import { crawl } from '../lib/net';
import { sing, reserveOk } from './api';

/**
 * P0 program acquisition (Singularity). Buys the TOR router, then the port openers and Formulas.exe from
 * the darkweb. One-shot and idempotent — re-run any time; it skips what you already own and can't afford.
 *
 * Openers are LEVEL-GATED: each is bought only once our hacking level reaches the lowest-level host it
 * unlocks, so we don't pay $250M for SQLInject before we can hack any 5-port server. (Once bought, root.js
 * roots every host that opener reaches for its RAM.) Cheap openers pass the gate early since their hosts
 * are low-level; the gate really only defers HTTPWorm and SQLInject. Formulas.exe ($5B) is surplus-only.
 *
 * Run: `run /singularity/programs.js`            buy everything gated + affordable
 *      `run /singularity/programs.js --no-root`  don't exec root.js after buying an opener
 */
const REV = 'v2';

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
  // 0.5, getDarkwebPrograms 1) plus a re-root exec (1.3). ×1 inside BN4; clamped to the host's RAM.
  if (!reserveOk(ns, 16, 10)) return;
  const s = sing(ns);

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

  // Lowest required hacking level among UN-ROOTED hosts needing exactly `ports` ports (Infinity if none).
  // Without opener N, all N-port hosts are un-rooted, so this is their true minimum.
  const hosts = crawl(ns);
  const level = ns.getHackingLevel();
  const minLevelForPorts = (ports: number): number => {
    let min = Infinity;
    for (const h of hosts) {
      if (h === 'home' || ns.hasRootAccess(h)) continue;
      if (ns.getServerNumPortsRequired(h) === ports) min = Math.min(min, ns.getServerRequiredHackingLevel(h));
    }
    return min;
  };

  // Cheapest(=fewest-ports)-first, each gated on our level reaching the lowest host it unlocks.
  for (const { file, ports } of OPENERS) {
    if (ns.fileExists(file, 'home')) continue;
    const cost = s['getDarkwebProgramCost'](file);
    if (cost <= 0) continue; // unavailable

    const need = minLevelForPorts(ports);
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
      ns.tprint(`  bought: ${file.padEnd(14)} (${ns.format.number(cost)}) — unlocks ${ports}-port hosts`);
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
