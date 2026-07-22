import type { NS } from '@ns';

/**
 * Tiny one-shot: waits for the running Singularity controller to exit, then launches a fresh one. The
 * controller uses this to relaunch itself LEAN after founding the gang — its P1 crime reservation (~30 GB)
 * is monotonic and can't shrink, so it exits and this brings up a new ~16 GB P2-sized controller once the
 * old one's RAM is freed. Runs on home; ~2 GB.
 *
 * Run: `run /singularity/relaunch.js`
 */
const REV = 'v1';

export async function main(ns: NS) {
  for (let i = 0; ns.isRunning('/singularity.js', 'home') && i < 120; i++) await ns.sleep(1000);
  const pid = ns.exec('/singularity/launch.js', 'home');
  ns.tprint(pid ? `INFO  relaunch ${REV}: brought up a fresh controller.` : 'ERROR  relaunch: launch failed.');
}
