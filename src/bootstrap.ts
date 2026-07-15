import type { NS } from '@ns';
import { VERSION } from './lib/ports';

/**
 * ~3.0 GB. Run once after any reset. RAM-adaptive: launches only the scripts that
 * fit the current home, in priority order, leaving headroom for rank/root execs.
 *
 * After a fresh BitNode home is 8 GB and only the daemon fits — that alone earns
 * (it targets n00dles, drains piles, all on the ~100 GB of 0-port pool). As you
 * upgrade home RAM, RE-RUN bootstrap and it adds monitor, then auto-buy, then
 * share. Home RAM survives augment installs, so on those you may already have room
 * for the whole stack immediately.
 *
 * share stays a separate 10s loop (share() lasts ~10s; it would lapse inside a
 * daemon round). It only touches idle RAM, so money-first still holds.
 *
 * Run: `run /bootstrap.js`
 */
/** This script's own revision — bump when THIS script's behaviour changes. */
const REV = 'v3';

const STACK = [
  { file: '/daemon.js', ram: 4.85, why: 'root + rank + decoupled hacking' },
  { file: '/monitor.js', ram: 2.4, why: 'dashboard' },
  { file: '/auto-buy.js', ram: 6.05, why: 'compound income into pool RAM' },
  { file: '/share.js', ram: 3.85, why: 'reputation from idle RAM' },
  // Lowest priority: self-gates on a cash floor, so it only spends surplus the rest can't use.
  { file: '/hacknet.js', ram: 7.2, why: 'mop surplus cash into hacknet (bridge income)' },
];
/** Launched ahead of the rest whenever we have a gang. Where hacking is throttled (BN2 caps
 * ServerMaxMoney at 0.08) the gang is the economy, not a side-channel — it out-earns the daemon
 * and is the only source of faction rep, so it gets first claim on home RAM.
 *
 * It reserves ~13 GB and execs helpers up to ~12.7 GB on top, hence the fatter headroom. */
const GANG = { file: '/gang.js', ram: 13.1, why: 'gang: money + faction rep (the BN2 economy)' };
const GANG_HEADROOM = 13;
/** Leave this much home RAM free after each launch, so the daemon can still exec
 * root.js (2.4 GB) on home. rank.js runs remotely when home is too small for it,
 * so we do NOT reserve its 5.45 GB here — that would skip the daemon on an 8 GB home. */
const LAUNCH_HEADROOM = 3;

export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint(`=== bootstrap ${REV} [build ${VERSION}] ===`);
  const homeMax = ns.getServerMaxRam('home');

  // `inGang` is 0 GB, so this check is free even on a fresh 8 GB home in a gangless BitNode.
  const stack = ns.gang.inGang() ? [GANG, ...STACK] : STACK;

  for (const { file, ram, why } of stack) {
    const headroom = file === GANG.file ? GANG_HEADROOM : LAUNCH_HEADROOM;
    if (ns.isRunning(file, 'home')) {
      ns.tprint(`  running:  ${file}`);
      continue;
    }
    const free = homeMax - ns.getServerUsedRam('home');
    if (free < ram + headroom) {
      ns.tprint(`  skip:     ${file.padEnd(14)} — needs ${ram} GB + headroom, home has ${ns.format.ram(free)} free`);
      continue;
    }
    const pid = ns.exec(file, 'home');
    ns.tprint(pid !== 0 ? `  launched: ${file.padEnd(14)} — ${why}` : `  FAILED:   ${file}`);
  }

  ns.tprint(`  home ${ns.format.ram(homeMax)} — upgrade it and re-run bootstrap to add more of the stack`);
  ns.tprint('');
}
