import type { NS } from '@ns';
import { liveStrategy } from '../lib/bitnode';
import { INSTALL_FILE } from '../lib/ports';
import { sing, reserveOk } from './api';

/**
 * P2 install (Singularity), one-shot. Owns the install DECISION so the controller stays lean. THIS RESETS
 * THE GAME. No-op unless a trigger fires. The controller exec's it on a timer, right after augs.js.
 *
 * ## Three triggers, any of which fires
 *
 *   1. COUNT   — `install.minAugsQueued` real augs are queued (and `minSpend` has been spent on them).
 *   2. STALLED — nothing further is purchasable and has not been for several passes. Waiting gains
 *                nothing: the `1.9^queued` price escalation only resets at an install.
 *   3. FAVOR   — the rep we are holding would carry a faction over the donation favor gate. That turns
 *                that faction's rep into a money cost for the rest of the BitNode (see `lib/favor.ts`),
 *                which is usually worth more than the augs still queued behind it.
 *
 * Triggers 2 and 3 are floored by `install.minAugsAnyTrigger`, so neither ever resets the run for a
 * trivial batch. `installWhenStalled` / `favorInstall` turn them off individually.
 *
 * ## Real augs, not queue entries
 *
 * `queueAugmentation` exempts NeuroFlux from its duplicate check, so a queued NFG level is its own entry in
 * `getOwnedAugmentations(true)`. Counting raw queue length therefore counts NFG levels as augmentations,
 * and "8 queued" could be zero actual augs. Every count here excludes NFG. The queued names are exactly the
 * tail of `owned(true)` past `owned(false)` — the game pushes installed augs first, then the queue.
 *
 * ## Spend everything first
 *
 * An install sets money to $1,000, so cash held at the reset is DESTROYED. Immediately before installing:
 *
 *   1. `contracts/run.js --wait` — bank every unsolved .cct, since the reset wipes them too.
 *   2. `augs.js --preinstall`    — reserve and donation cap lifted: buy anything still buyable, then run
 *                                  the NeuroFlux ladder. This is the ONLY moment NFG is ever bought, since
 *                                  each level inflates `1.9^queued` for real augs.
 *   3. `home.js --dump`          — last resort for the remainder: home cores (capped at 8), then home RAM.
 *                                  NFG's escalation stops it long before a mature run's cash runs out, and
 *                                  home RAM/cores are among the few things that SURVIVE the reset.
 *
 * Each step is best-effort: if home is too full to launch one, it is logged and the install proceeds.
 *
 * Run: `run /singularity/install.js`         respect the config triggers
 *      `run /singularity/install.js --force`  install now, bypassing the triggers — and unlike the normal
 *                                             path it does NOT require a pre-existing queue, since the
 *                                             spend-down above is what fills one. That is what redpill.js
 *                                             needs for the favor bank, where the reset itself is the point
 *                                             and nothing has been bought. It still refuses to call
 *                                             `installAugmentations` if the queue is empty afterwards —
 *                                             that call no-ops silently and would loop the caller forever.
 */
const REV = 'v4';
const NFG = 'NeuroFlux Governor';

/** Consecutive stalled passes before trigger 2 fires. Income is continuous, so a single "cannot afford
 * anything" pass is noise; a streak is a real ceiling. At the controller's 120s aug cadence this is ~6 min. */
const STALLED_PASSES = 3;

/** augs.js's record for the current install cycle. Fail-SAFE: unreadable, malformed or stale reads as
 * "no reason to install". An install is destructive and irreversible — never infer one from a bad parse. */
interface Advice {
  stalledPasses: number;
  favorCrossings: string[];
  spent: number;
  detail: string;
}
function readAdvice(ns: NS, augReset: number): Advice {
  const safe: Advice = { stalledPasses: 0, favorCrossings: [], spent: 0, detail: '' };
  try {
    const raw = ns.read(INSTALL_FILE);
    if (!raw) return safe;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o['augReset'] !== augReset) return safe; // from a previous cycle — discard
    const crossings = o['favorCrossings'];
    return {
      stalledPasses: typeof o['stalledPasses'] === 'number' ? o['stalledPasses'] : 0,
      favorCrossings: Array.isArray(crossings) ? crossings.filter((x): x is string => typeof x === 'string') : [],
      spent: typeof o['spent'] === 'number' ? o['spent'] : 0,
      detail: typeof o['detail'] === 'string' ? o['detail'] : '',
    };
  } catch {
    return safe;
  }
}

export async function main(ns: NS) {
  const flags = ns.flags([
    ['force', false],
    ['relaxed', false],
  ]);
  if (!reserveOk(ns, 16, 12)) return;
  const s = sing(ns);
  const info = ns.getResetInfo();
  const strat = liveStrategy(ns, info.currentNode);

  // The queue is the tail of owned(true) past owned(false) — installed augs are pushed first.
  const installed = s['getOwnedAugmentations'](false);
  const queuedNames = s['getOwnedAugmentations'](true).slice(installed.length);
  const realQueued = queuedNames.filter((n) => n !== NFG).length;

  const force = flags['force'] as boolean;
  // Empty queue: nothing to install, stay quiet on the timer. But NOT under --force, which exists for
  // resets whose VALUE is the reset itself rather than the augs — redpill.js's favor bank is the case:
  // it installs to convert Daedalus rep into favor, and in close mode nothing has been bought, so the
  // queue is empty by definition. Returning here would make --force a silent no-op, and the caller
  // (which cannot see why) retries forever. The spend-down below is what CREATES the queue, so force
  // must fall through to it; the re-count before the install is the real guard.
  if (queuedNames.length === 0 && !force) return;
  const advice = readAdvice(ns, info.lastAugReset);

  // `--relaxed`: passed by the controller ONLY when its projection has PROVEN that installing reaches the
  // hacking goal sooner than finishing the current climb. It drops both thresholds to a single aug.
  //
  // Batch thresholds amortize the re-bootstrap tax, which is the right trade while a run is still making
  // progress — but they are the wrong instrument for the endgame. Late in a run most augs are owned and the
  // few left sit behind enormous rep, so "three more augs" can be unreachable while the one already queued is
  // worth everything. Measured live: two queued augs moved the hacking multiplier 16.88 -> 25.24, cutting the
  // XP for level 9000 from 8.94e9 to 3.60e7 — a 248x reduction, not a batch worth waiting to enlarge.
  //
  // The safety is upstream, in the controller: `hackMultGain` of 1 makes a post-install estimate that starts
  // from zero XP strictly worse than continuing, so an aug granting no hacking multiplier can never earn this
  // flag. That is what keeps a floor of 1 from thrashing.
  const relaxed = flags['relaxed'] as boolean;
  const countNeeded = relaxed ? 1 : strat.install.minAugsQueued;
  const floor = realQueued >= (relaxed ? 1 : strat.install.minAugsAnyTrigger);

  let trigger = '';
  if (force) trigger = 'force';
  else if (!strat.install.autoInstall) trigger = '';
  else if (realQueued >= countNeeded && advice.spent >= strat.install.minSpend) trigger = 'count';
  else if (floor && strat.install.installWhenStalled && advice.stalledPasses >= STALLED_PASSES) trigger = 'stalled';
  else if (floor && strat.install.favorInstall && advice.favorCrossings.length > 0) trigger = 'favor';

  if (!trigger) {
    ns.print(
      `install: ${realQueued} real aug(s) queued (+${queuedNames.length - realQueued} NFG), no trigger — ` +
        `count ${realQueued}/${countNeeded}, stalled ${advice.stalledPasses}/${STALLED_PASSES}, ` +
        `favor [${advice.favorCrossings.join(', ')}], floor ${strat.install.minAugsAnyTrigger}`,
    );
    return;
  }

  const why =
    trigger === 'count'
      ? `${realQueued} real aug(s) queued`
      : trigger === 'stalled'
        ? `nothing purchasable for ${advice.stalledPasses} passes — escalation only resets on install`
        : trigger === 'favor'
          ? `favor gate crossing at ${advice.favorCrossings.join(', ')}`
          : 'forced';

  // FINAL contract sweep before the reset. Installing wipes the world and every unsolved .cct, so bank
  // their rep (-> persistent faction favor) and cash NOW, while we still can. run.js places the ~24 GB
  // solver on a pool host (not home), and --wait blocks us here until it finishes, so nothing is lost to
  // the reset. Best-effort: if no host is big enough, run.js solves nothing and we install anyway — never
  // block an install forever. This only ever runs here, at the actual reset, not on the controller's timer.
  const swp = ns.exec('/contracts/run.js', 'home', 1, 'solve', '--wait', '--quiet');
  if (swp !== 0) {
    while (ns.isRunning(swp)) await ns.sleep(500);
  } else {
    ns.tprint('install: contract sweep could not launch (home full) — installing without it.');
  }

  // Spend down. Contracts just paid out, so this runs AFTER the sweep: buy anything still buyable with the
  // reserve lifted, then convert the remainder into NeuroFlux levels. Whatever is left when the reset lands
  // becomes $1,000. Best-effort — if home is too full for the ~39 GB pass, install anyway rather than stall.
  const spend = ns.exec('/singularity/augs.js', 'home', 1, '--preinstall');
  if (spend !== 0) {
    while (ns.isRunning(spend)) await ns.sleep(500);
  } else {
    ns.tprint('install: pre-install spend-down could not launch (home full) — installing with cash unspent.');
  }

  // LAST RESORT for whatever the augs and the NeuroFlux ladder could not absorb. Home cores and home RAM
  // are among the only things that survive the reset, and NFG's 1.9x-per-level escalation terminates it
  // long before a mature run's cash does — so without this, the remainder simply becomes $1,000. Cores
  // first (capped at 8, so it finishes), then RAM to `home.dumpRamCap`, ignoring the operational pacing
  // gates. Also the fastest way back: purchased servers do not survive, so home is the whole pool during
  // the re-bootstrap.
  const dump = ns.exec('/singularity/home.js', 'home', 1, '--dump');
  if (dump !== 0) {
    while (ns.isRunning(dump)) await ns.sleep(500);
  } else {
    ns.tprint('install: home dump could not launch (home full) — leftover cash will be lost to the reset.');
  }

  // Re-count: the pre-install pass just bought more augs AND the NFG levels, so the numbers above are stale.
  const finalQueue = s['getOwnedAugmentations'](true).slice(installed.length);
  const finalReal = finalQueue.filter((n) => n !== NFG).length;

  // THE GUARD. `installAugmentations` silently does nothing on an empty queue — verified in the live d.ts:
  // "If you do not own any queued Augmentations then the game will not reset." It does not throw and does
  // not return a status, so a caller that assumes it reset will loop forever with no diagnostic. That is
  // exactly what a forced favor-bank install did before the spend-down was allowed to run first. If the
  // spend-down still bought nothing, say so loudly rather than pretending to reset.
  if (finalQueue.length === 0) {
    ns.tprint(
      `WARN install ${REV}: ${why}, but the queue is EMPTY after the spend-down — installAugmentations ` +
        `would no-op. Nothing was purchasable (check cash, faction membership, and augs.neuroFluxDump). ` +
        `NOT resetting.`,
    );
    return;
  }

  ns.tprint(
    `=== install ${REV} — ${why}; installing ${finalReal} aug(s) + ` +
      `${finalQueue.length - finalReal}x ${NFG}, relaunching ===`,
  );
  s['installAugmentations']('/bootstrap.js'); // resets the game; runs the callback afterwards
}
