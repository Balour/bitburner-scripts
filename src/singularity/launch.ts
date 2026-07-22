import type { NS } from '@ns';

/**
 * Places the Singularity controller — HOME ONLY, and here's why. The controller reserves ~26 GB via
 * ramOverride for its bracket-hidden Singularity calls. On a POOL host the daemon fills the free RAM with
 * hack/grow/weaken workers, so the controller's reservation is starved and it dies the first time it calls
 * a Singularity function (that was the crash: it got 8 GB on `millenium-fitness`). home's HOME_RESERVE
 * keeps the daemon's workers off, so the controller can reserve cleanly there.
 *
 * In BN4, monitor/share/auto-buy are BN_DISABLE'd during the karma grind so the ~26 GB controller fits a
 * 32 GB home next to the daemon. If home still can't fit it, upgrade home — do NOT fall back to a pool host.
 *
 * Idempotent: no-op if the controller is already running on home. bootstrap runs this each pass.
 *
 * Run: `run /singularity/launch.js`
 */
const REV = 'v1';
const CONTROLLER = '/singularity.js';

/** Home MAX RAM the controller needs to coexist with the daemon (~26 GB controller + ~5 GB daemon
 * resident). We check CAPACITY, not current free — the daemon's transient rank/root execs make free RAM
 * dip momentarily, and the controller's own startup retry-loop waits those out. Verify in-game. */
const SING_HOME_MIN = 31;

export async function main(ns: NS) {
  if (ns.isRunning(CONTROLLER, 'home')) {
    ns.tprint('INFO  singularity already running on home.');
    return;
  }

  if (ns.getServerMaxRam('home') < SING_HOME_MIN) {
    ns.tprint(
      `ERROR  singularity: home is ${ns.format.ram(ns.getServerMaxRam('home'))}, needs ~${SING_HOME_MIN} GB to run ` +
        `alongside the daemon. Upgrade home — NOT placing on a pool host (the daemon would starve it).`,
    );
    return;
  }

  const pid = ns.exec(CONTROLLER, 'home');
  ns.tprint(pid ? `SUCCESS  singularity ${REV} launched on home (pid ${pid}).` : 'ERROR  exec failed on home.');
}
