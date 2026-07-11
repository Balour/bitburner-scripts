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
 * share.js is deliberately NOT started — reputation is a spare-RAM top-up you turn
 * on during faction work, per the money-first plan. `run /share.js` when you want it.
 *
 * Run: `run /bootstrap.js`
 */
const STACK = [
  { file: '/daemon.js', why: 'root + rank + drain/prep/sustain hacking' },
  { file: '/monitor.js', why: 'dashboard' },
  { file: '/auto-buy.js', why: 'compound income into pool RAM' },
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
  ns.tprint(`  reputation: run /share.js during faction work for a share() boost`);
  ns.tprint('');
}
