import type { NS } from '@ns';
import { VERSION } from '../lib/ports';

/**
 * ~3.0 GB (base 1.6 + exec 1.3 + isRunning 0.1). Resident periodic contract solver, launched by
 * bootstrap. Coding contracts spawn on scattered servers over time and are wiped by every augment
 * install, so this sweeps them on a cadence to bank cash (valuable early) + faction rep as they appear.
 *
 * It does NOT solve anything itself — it delegates to `/contracts/run.js solve`, which places the
 * ~24 GB solver on the biggest rooted host and ERROR-skips (harmlessly) when none is big enough. The
 * --wait makes each delegated sweep block to completion, which SERIALIZES us: two solves never overlap,
 * so no double-attempt churn. --quiet keeps it off the terminal — a solve only speaks up when it
 * actually solves something (or a solver FAILs).
 *
 * The guaranteed FINAL sweep right before an install lives in /singularity/install.js, not here.
 *
 * Run: launched by `/bootstrap.js`; suppress with `run /bootstrap.js --no-contracts`.
 */
const REV = 'v1';

/** 10 min — matches the game's contract spawn rate; tighter intervals mostly re-sweep nothing. */
const CONTRACTS_EVERY_MS = 600_000;

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.print(`contracts-loop ${REV} [build ${VERSION}] — sweeping every ${CONTRACTS_EVERY_MS / 60_000} min`);

  while (true) {
    // Sweep immediately on launch (early cash), then every interval. run.js runs on home (~4 GB) and
    // places the heavy solve elsewhere. exec returns 0 if home is momentarily full — just retry next tick.
    const pid = ns.exec('/contracts/run.js', 'home', 1, 'solve', '--wait', '--quiet');
    if (pid !== 0) {
      while (ns.isRunning(pid)) await ns.sleep(1000);
    }
    await ns.sleep(CONTRACTS_EVERY_MS);
  }
}
