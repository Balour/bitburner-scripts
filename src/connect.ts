import type { NS } from '@ns';
import { pathTo } from './lib/net';

/**
 * ~3 GB. Resolve the network path from `home` to a named server and hand you a
 * single terminal command that connects there (and backdoors) in one paste.
 *
 * We have no SF-4, so there is no script API to change the current server — the
 * only lever is the terminal. Bitburner's terminal runs a `;`-separated line as
 * sequential commands, and `connect` succeeds to any adjacent host, so the BFS
 * path `home -> a -> ... -> target` becomes `home; connect a; ...; connect
 * target; backdoor`. Copy that line into the terminal and press Enter.
 *
 * When SF-4 eventually exists this same script auto-connects and backdoors via
 * the Singularity API. That branch is reached through bracket access so the
 * static RAM parser never sees it — the script stays 8 GB-safe on future resets.
 *
 * Run: `run /connect.js CSEC`   (add `--no-backdoor` to connect only, once SF-4)
 */

/** Shape we reach via bracket access so the static parser can't cost it. */
type Singularity = { connect(host: string): boolean; installBackdoor(): Promise<void> };

export async function main(ns: NS) {
  const flags = ns.flags([['no-backdoor', false]]);
  const withBackdoor = !flags['no-backdoor'];
  const target = String(ns.args[0] ?? '');

  if (!target) {
    ns.tprint('ERROR: no target server. Usage: run /connect.js <server> [--no-backdoor]');
    return;
  }

  const route = pathTo(ns, target);
  if (!route) {
    ns.tprint(`ERROR: server not found: ${target}`);
    return;
  }
  if (route.length === 1) {
    ns.tprint("INFO: that's home — you're already there.");
    return;
  }

  ns.tprint('');
  ns.tprint(`path: ${route.join(' -> ')}`);

  // Cheap sanity checks so a doomed backdoor isn't a surprise.
  if (!ns.hasRootAccess(target)) {
    ns.tprint(`WARN: no root on ${target} — backdoor will fail until you nuke it.`);
  } else if (ns.getHackingLevel() < ns.getServerRequiredHackingLevel(target)) {
    ns.tprint(
      `WARN: hacking level ${ns.getHackingLevel()} < ${ns.getServerRequiredHackingLevel(target)} required — backdoor will fail.`,
    );
  }

  // The hops after home, as `connect X` commands. `home;` prefix resets to a
  // known start so the chain is valid no matter where you currently stand.
  const hops = route.slice(1).map((host) => `connect ${host}`);
  const base = ['home', ...hops].join('; ');

  ns.tprint('');
  ns.tprint(`connect only:      ${base}`);
  ns.tprint(`connect+backdoor:  ${base}; backdoor`);
  ns.tprint('');

  // --- Singularity auto path: dormant until SF-4 exists. ---
  const reset = ns.getResetInfo();
  const hasSf4 = (reset.ownedSF.get(4) ?? 0) > 0 || reset.currentNode === 4;
  if (!hasSf4) return;

  // Lift the reservation so the (dynamically-costed) Singularity calls are
  // payable; at SF-4 level 1 connect + installBackdoor total 64 GB distinct, so
  // reserve above that. Home has the RAM whenever SF-4 is in play.
  ns.ramOverride(128);
  const sing = (ns as unknown as Record<string, unknown>)['singularity'] as Singularity;
  for (const host of route.slice(1)) sing['connect'](host);
  if (withBackdoor) {
    await sing['installBackdoor']();
    ns.tprint(`SUCCESS: connected to ${target} and installed backdoor.`);
  } else {
    ns.tprint(`SUCCESS: connected to ${target}.`);
  }
}
