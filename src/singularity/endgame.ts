import type { NS } from '@ns';
import { pathTo } from '../lib/net';
import { liveStrategy } from '../lib/bitnode';
import { sing, reserveOk, isBackdoored } from './api';
import { ENDGAME_FILE } from '../lib/ports';

/**
 * P3 endgame close-out (Singularity), one-shot. Only run once The Red Pill is INSTALLED (which wired
 * w0r1d_d43m0n into the network) AND hacking has re-climbed to the daemon requirement. Verified against the
 * live d.ts + bitburner-src:
 *   - `destroyW0r1dD43m0n` needs `hacking >= req && w0r1d_d43m0n rooted` (OR the Bladeburner final black op).
 *   - `installBackdoor` on the daemon needs the same root+level, and on success opens the BitVerse and WAITS
 *     for the player to pick the next node — a clean unattended stop that commits to nothing.
 * So the daemon must first be ROOTED here (it isn't in the network until the Red Pill install, so root.js
 * won't have touched it), then:
 *   - autoDestroy off (default): navigate to it and backdoor -> BitVerse waits for your node choice.
 *   - autoDestroy on: `destroyW0r1dD43m0n(nextNode, '/bootstrap.js')` -> auto-jump into the next BitNode.
 *
 * Idempotent: if the daemon is already backdoored it just records 'bitverse' and returns. If it can't root
 * the daemon yet (openers not re-bought post-install), it records 'await-root' so the controller retries.
 *
 * RAM: the backdoor route is cheap (~14 GB); `destroyW0r1dD43m0n` alone is 32 GB, so autoDestroy needs a
 * fat home with ~40 GB free — if it can't reserve that it bails and the controller retries.
 *
 * Run: `run /singularity/endgame.js`
 */
const REV = 'v2';
const WD = 'w0r1d_d43m0n';

/** Navigate from the current server to `dest` via adjacent hops (installBackdoor acts on the connected
 * server; connect reaches neighbours only). Returns false if unreachable. */
function navigate(ns: NS, s: ReturnType<typeof sing>, dest: string): boolean {
  const route = pathTo(ns, dest, s['getCurrentServer']());
  if (!route) return false;
  for (const hop of route.slice(1)) if (!s['connect'](hop)) return false;
  return true;
}

export async function main(ns: NS) {
  const info = ns.getResetInfo();
  const strat = liveStrategy(ns, info.currentNode);
  const auto = strat.endgame.autoDestroy;

  // ns.write is free (0 GB), so this is defined before the reservation and usable even when it fails.
  const write = (phase: string, detail: string) =>
    ns.write(
      ENDGAME_FILE,
      JSON.stringify({ rev: REV, nodeReset: info.lastNodeReset, redPillInstalled: true, phase, detail }),
      'w',
    );

  // destroyW0r1dD43m0n is 32 GB; the backdoor route is ~14. Reserve for whichever path we're taking. On a
  // failure, record it (don't bail silently) so the controller/user can see WHY the close-out isn't finishing
  // — the 40 GB destroy reservation in particular won't fit next to the controller + daemon on a modest home.
  const need = auto ? 40 : 18;
  if (!reserveOk(ns, auto ? 44 : 28, need)) {
    write(
      'await-ram',
      `endgame needs ${need} GB free on home (${auto ? 'destroy' : 'backdoor'} path) — too full now, retrying`,
    );
    return;
  }
  const s = sing(ns);

  // w0r1d_d43m0n needs all five ports. The Red Pill install wiped the openers (prestigeAllServers), and we
  // can't rely on programs.js to have re-bought them — its per-port-count level-gate doesn't recognize that a
  // 5-port host justifies the cheaper openers, and it races the controller for home RAM and often bails. So
  // buy any missing opener here, in our OWN reservation. We're always rich by the endgame, so no cost gate.
  const OPENERS = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe'];
  if (OPENERS.some((f) => !ns.fileExists(f, 'home'))) {
    if (!ns.hasTorRouter()) s['purchaseTor']();
    for (const f of OPENERS) if (!ns.fileExists(f, 'home')) s['purchaseProgram'](f);
  }

  // The daemon only joined the network at the Red Pill install, so it's un-rooted. Open its ports and nuke.
  if (!ns.hasRootAccess(WD)) {
    if (ns.fileExists('BruteSSH.exe', 'home')) ns.brutessh(WD);
    if (ns.fileExists('FTPCrack.exe', 'home')) ns.ftpcrack(WD);
    if (ns.fileExists('relaySMTP.exe', 'home')) ns.relaysmtp(WD);
    if (ns.fileExists('HTTPWorm.exe', 'home')) ns.httpworm(WD);
    if (ns.fileExists('SQLInject.exe', 'home')) ns.sqlinject(WD);
    ns.nuke(WD);
  }
  if (!ns.hasRootAccess(WD)) {
    write('await-root', 'w0r1d_d43m0n still not rooted — a port-opener purchase may have failed; retrying');
    ns.tprint(`=== endgame ${REV} — cannot root ${WD} yet; will retry ===`);
    return;
  }

  // autoDestroy: jump straight into the next BitNode (this call resets us; the callback relaunches the stack).
  if (auto) {
    ns.tprint(`=== endgame ${REV} — destroying ${WD}, entering BN${strat.endgame.nextNode} ===`);
    s['destroyW0r1dD43m0n'](strat.endgame.nextNode, '/bootstrap.js');
    return;
  }

  // Default: backdoor the daemon -> the game opens the BitVerse and waits for YOU to choose the next node.
  if (isBackdoored(ns, WD)) {
    write('bitverse', 'w0r1d_d43m0n already backdoored — pick your next BitNode in the BitVerse');
    ns.tprint(`=== endgame ${REV} — ${WD} already backdoored; open the BitVerse to choose a node ===`);
    return;
  }
  if (!navigate(ns, s, WD)) {
    write('await-root', `could not navigate to ${WD} — retrying`);
    ns.tprint(`=== endgame ${REV} — could not reach ${WD}; will retry ===`);
    return;
  }
  ns.tprint(`=== endgame ${REV} — backdooring ${WD} (opens the BitVerse; pick your next node there) ===`);
  await s['installBackdoor'](); // resolves into Page.BitVerse and waits for the player
  write('bitverse', 'w0r1d_d43m0n backdoored — pick your next BitNode in the BitVerse');
}
