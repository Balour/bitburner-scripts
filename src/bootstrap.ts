import type { NS } from '@ns';
import { VERSION } from './lib/ports';

/**
 * 3.00 GB. Run this once after any reset. Launches the money stack and exits.
 *
 * There is no stage detection to do: home RAM survives augment installs (only
 * purchased servers and levels reset), and the daemon already adapts to level on
 * its own — bootstrap-target while weak, drain piles, prep a giant once RAM
 * allows. So this just starts the persistent scripts and gets out of the way.
 *
 * share.js runs on a SEPARATE loop, not inside the daemon: share() lasts ~10s and
 * must be re-launched that often to stay active, but a daemon round takes minutes,
 * so share woven into it would lapse ~98% of the time. It only touches genuinely
 * idle RAM (the pool has ~90 TB the daemon never uses), so it never costs money —
 * money-first still holds. It only helps while you are working a faction, but is
 * harmless otherwise, so we just leave it on.
 *
 * Run: `run /bootstrap.js`
 */
const STACK = [
  { file: '/daemon.js', why: 'root + rank + drain/prep/sustain hacking' },
  { file: '/monitor.js', why: 'dashboard' },
  { file: '/auto-buy.js', why: 'compound income into pool RAM' },
  { file: '/share.js', why: 'reputation from idle RAM (helps while working a faction)' },
];

export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint(`=== bootstrap ${VERSION} ===`);
  for (const { file, why } of STACK) {
    if (ns.isRunning(file, 'home')) {
      ns.tprint(`  already running: ${file}`);
      continue;
    }
    const pid = ns.exec(file, 'home');
    ns.tprint(pid !== 0 ? `  launched ${file.padEnd(16)} — ${why}` : `  FAILED to launch ${file} (home out of RAM?)`);
  }
  ns.tprint(`  share.js runs on idle RAM — boosts rep while you work a faction`);
  ns.tprint('');
}
