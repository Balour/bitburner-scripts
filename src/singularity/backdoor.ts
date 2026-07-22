import type { NS } from '@ns';
import { crawl, pathTo } from '../lib/net';
import { sing, reserve, isBackdoored } from './api';

/**
 * Backdoor pass (Singularity), decoupled from rooting. Rooting stays immediate ("root now, backdoor
 * later"); this walks to each eligible server and installs a backdoor, faction/story servers FIRST
 * because those grant the hacking-faction invites the aug loop needs.
 *
 * Eligible = rooted + our hacking level meets the server's requirement + not already backdoored.
 * Level-gated servers are reported, not forced; re-run as hacking climbs and they clear on their own.
 * Idempotent. One-shot: the controller runs it periodically and awaits it (backdoor uses the single
 * player action slot, so it must not overlap the crime grind).
 *
 * `installBackdoor` acts on the CURRENTLY CONNECTED server and `connect` reaches neighbors only, so we
 * navigate hop-by-hop via `pathTo` from wherever we stand, and return to home at the end.
 *
 * Verified (bitburner-src backdoor handler): backdoor's ONLY mechanical effect is re-checking faction
 * invitations — the five faction servers below are the only ones it gates in the base game. It grants
 * no rep/money/infiltration/company benefit, so `--all` buys nothing but human terminal-connect QoL at
 * the cost of action-slot time. (Infiltration is a separate manual minigame; `ns.infiltration` is
 * read-only, so it cannot be scripted without sleeves/SF-10.)
 *
 * Run: `run /singularity/backdoor.js`         faction servers only (default — the ones that matter)
 *      `run /singularity/backdoor.js --all`   also backdoor every other server (QoL only, no benefit)
 */
const REV = 'v1';

/** The servers whose backdoor grants a faction invite: CyberSec -> NiteSec -> The Black Hand ->
 * BitRunners -> Fulcrum. These are the only backdoor-gated factions in the base game. */
const FACTION_SERVERS = ['CSEC', 'avmnite-02h', 'I.I.I.I', 'run4theh111z', 'fulcrumassets'];

/** NEVER auto-backdoor these. w0r1d_d43m0n's backdoor is the ENDGAME trigger (-> BitVerse, node exit);
 * it is owned deliberately by P3, and `--all`'s crawl would otherwise reach it once hacking is high. */
const EXCLUDE = new Set(['home', 'w0r1d_d43m0n']);

/** Navigate from the current server to `dest` via adjacent hops. Returns false if unreachable. */
function navigate(ns: NS, s: ReturnType<typeof sing>, dest: string): boolean {
  const route = pathTo(ns, dest, s['getCurrentServer']());
  if (!route) return false;
  for (const hop of route.slice(1)) if (!s['connect'](hop)) return false;
  return true;
}

export async function main(ns: NS) {
  const flags = ns.flags([['all', false]]);
  const all = flags['all'] as boolean;

  // Cover the bracket-hidden calls: getCurrentServer 2, connect 2, installBackdoor 2, getServer 2, plus
  // scan (via pathTo). ×1 inside BN4; clamped to the running host's RAM.
  reserve(ns, 24);
  const s = sing(ns);
  const level = ns.getHackingLevel();

  // Priority set first, then (optionally) everything else rooted. Filter to reachable, unseen hosts.
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (h: string) => {
    if (!EXCLUDE.has(h) && !seen.has(h) && pathTo(ns, h) !== null) {
      seen.add(h);
      candidates.push(h);
    }
  };
  FACTION_SERVERS.forEach(add);
  if (all) for (const h of crawl(ns)) add(h);

  ns.tprint('');
  ns.tprint(`=== backdoor ${REV} — hacking ${level} ===`);

  const done: string[] = [];
  const gated: { host: string; req: number }[] = [];

  for (const host of candidates) {
    if (!ns.hasRootAccess(host)) continue;
    const req = ns.getServerRequiredHackingLevel(host);
    if (level < req) {
      gated.push({ host, req });
      continue;
    }
    if (isBackdoored(ns, host)) continue;

    if (!navigate(ns, s, host)) {
      ns.tprint(`  unreachable: ${host}`);
      continue;
    }
    await s['installBackdoor']();
    done.push(host);
    ns.tprint(`  backdoored: ${host}`);
  }

  // Leave the player at home rather than stranded deep in the tree.
  navigate(ns, s, 'home');

  ns.tprint(`  done — ${done.length ? `backdoored ${done.join(', ')}` : 'nothing new'}`);
  if (gated.length) {
    const summary = gated
      .sort((a, b) => a.req - b.req)
      .map((g) => `${g.host}(${g.req})`)
      .join(', ');
    ns.tprint(`  gated by level: ${summary} — re-run as hacking climbs`);
  }
  ns.tprint('');
}
