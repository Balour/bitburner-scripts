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
const STACK = [
  { file: '/daemon.js', ram: 4.85, why: 'root + rank + decoupled hacking' },
  { file: '/monitor.js', ram: 2.4, why: 'dashboard' },
  { file: '/auto-buy.js', ram: 6.05, why: 'compound income into pool RAM' },
  { file: '/share.js', ram: 3.85, why: 'reputation from idle RAM' },
];
/** Leave this much home RAM free after each launch, so the daemon can still exec
 * root.js (2.4 GB) on home. rank.js runs remotely when home is too small for it,
 * so we do NOT reserve its 5.45 GB here — that would skip the daemon on an 8 GB home. */
const LAUNCH_HEADROOM = 3;

export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint(`=== bootstrap ${VERSION} ===`);
  const homeMax = ns.getServerMaxRam('home');

  for (const { file, ram, why } of STACK) {
    if (ns.isRunning(file, 'home')) {
      ns.tprint(`  running:  ${file}`);
      continue;
    }
    const free = homeMax - ns.getServerUsedRam('home');
    if (free < ram + LAUNCH_HEADROOM) {
      ns.tprint(`  skip:     ${file.padEnd(14)} — needs ${ram} GB + headroom, home has ${ns.format.ram(free)} free`);
      continue;
    }
    const pid = ns.exec(file, 'home');
    ns.tprint(pid !== 0 ? `  launched: ${file.padEnd(14)} — ${why}` : `  FAILED:   ${file}`);
  }

  ns.tprint(`  home ${ns.format.ram(homeMax)} — upgrade it and re-run bootstrap to add more of the stack`);
  ns.tprint('');
}
