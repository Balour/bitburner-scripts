import type { NS } from '@ns';
import { pathTo } from './lib/net';
import { reserve, sing } from './singularity/api';

/**
 * 3.25 GB. Resolve the network path from `home` to a named server and print a
 * single terminal command that connects there (and backdoors) in one paste —
 * then, if SF-4 is in play, walk that path for you via the Singularity API.
 *
 * The terminal line is not a fallback for the SF-4-less past; it is the answer
 * whenever home is too full to afford the Singularity reservation, so it is
 * always printed first. Bitburner's terminal runs a `;`-separated line as
 * sequential commands, and `connect` succeeds to any adjacent host, so the BFS
 * path `home -> a -> ... -> target` becomes `home; connect a; ...; connect
 * target; backdoor`. Copy it into the terminal and press Enter.
 *
 * The Singularity calls go through `sing()`'s string-literal bracket access, so
 * the static parser never bills them; they are paid dynamically under `reserve()`.
 *
 * Run: `run /connect.js CSEC`   (add `--no-backdoor` to connect only)
 */

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
  // `activeSourceFileLvl`: being inside the node counts as one free level on top
  // of what you own. Level drives the Singularity RAM tax, so read it, never
  // assume — this is what the failed `ramOverride(128)` got wrong.
  const sf4 = Math.min((reset.ownedSF.get(4) ?? 0) + (reset.currentNode === 4 ? 1 : 0), 3);
  if (sf4 < 1) return;

  // `connect` and `installBackdoor` are 2 GB each, ×16 at SF-4.1, ×4 at level 2,
  // ×1 at level 3. Distinct functions are billed once, however many hops. The
  // reservation only DEFERS that cost — it is charged for real at call time, so
  // ask for exactly it and bail if home can't spare it. A fixed 128 GB request
  // is refused outright on a 32 GB home and leaves the allocation at ~3 GB, which
  // is how this script died at 5.00 GB on its first `connect`.
  const tax = sf4 >= 3 ? 1 : sf4 === 2 ? 4 : 16;
  const need = ns.ramOverride() + (2 + (withBackdoor ? 2 : 0)) * tax;
  const got = reserve(ns, need);
  if (got < need) {
    ns.tprint(
      `WARN: Singularity path needs ${need.toFixed(2)} GB, only got ${got.toFixed(2)} — home is too full. Paste the line above instead.`,
    );
    return;
  }

  const s = sing(ns);
  // Walk the FULL route, `home` included. The route is a BFS from home, so the
  // first hop is only adjacent to wherever we currently stand if that is home —
  // and nothing here says it is. `connect('home')` costs no extra RAM (same
  // distinct function) and either resets us to a known start or returns false
  // harmlessly. Stop on the first refusal instead of walking a broken chain.
  for (const host of route) {
    if (s['connect'](host) || host === 'home') continue;
    ns.tprint(`ERROR: connect ${host} refused — stopped mid-path. Paste the terminal line above instead.`);
    return;
  }
  if (withBackdoor) {
    await s['installBackdoor']();
    ns.tprint(`SUCCESS: connected to ${target} and installed backdoor.`);
  } else {
    ns.tprint(`SUCCESS: connected to ${target}.`);
  }
}
