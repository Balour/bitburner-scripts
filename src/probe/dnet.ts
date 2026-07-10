import type { NS } from '@ns';

/**
 * Read-only reconnaissance of the v3 Darknet. Uses only the cheap calls, so it
 * fits comfortably in an 8 GB home:
 *   probe 0.2 | getServerDetails 0.1 | getDepth 0.1 | isDarknetServer 0.1
 *   getServerRequiredCharismaLevel 0.1 | getBlockedRam 0 | getStasisLinkLimit 0
 *
 * Deliberately calls NOTHING that mutates state — no phishingAttack, no
 * heartbleed, no unleashStormSeed, no nextMutation.
 *
 * Run: `run /probe/dnet.js`
 */
export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint('=== darknet recon (read-only) ===');

  let hosts: string[];
  try {
    hosts = ns.dnet.probe();
  } catch (e) {
    ns.tprint(`  ns.dnet.probe() failed -> ${e}`);
    ns.tprint('  Darknet appears locked or unavailable at this stage.');
    return;
  }

  ns.tprint(`  probe() returned ${hosts.length} host(s)`);
  if (hosts.length === 0) {
    ns.tprint('  Nothing reachable yet — likely gated behind progression.');
  }

  try {
    ns.tprint(`  stasis link limit: ${ns.dnet.getStasisLinkLimit()}`);
    ns.tprint(`  instability: ${JSON.stringify(ns.dnet.getDarknetInstability())}`);
  } catch (e) {
    ns.tprint(`  instability/stasis unavailable -> ${e}`);
  }

  for (const host of hosts.slice(0, 8)) {
    try {
      const details = ns.dnet.getServerDetails(host);
      ns.tprint(
        `  ${host}: depth=${ns.dnet.getDepth(host)} ` +
          `blockedRam=${ns.dnet.getBlockedRam(host)} ` +
          `charisma=${ns.dnet.getServerRequiredCharismaLevel(host)}`,
      );
      ns.tprint(`    details: ${JSON.stringify(details)}`);
    } catch (e) {
      ns.tprint(`  ${host}: details unavailable -> ${e}`);
    }
  }
  ns.tprint('');
}
