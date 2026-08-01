import type { NS } from '@ns';
import { sing, reserveOk, donationRate } from './api';
import { liveStrategy } from '../lib/bitnode';
import { repToReachFavor } from '../lib/favor';
import { ENDGAME_FILE } from '../lib/ports';

/**
 * P3 Red Pill acquisition (Singularity), one-shot. The long pole of clearing a BitNode: The Red Pill is a
 * 2.5M-rep / $0 augment sold ONLY by Daedalus, and it must be INSTALLED before w0r1d_d43m0n even joins the
 * network (verified: Prestige.ts links the daemon to The-Cave iff `hasAugmentation(TheRedPill, true)`).
 *
 * The controller runs this once we've PROVEN we can hit the daemon hacking req, and it owns the action slot
 * for the whole close-out:
 *   - not in Daedalus  -> report 'await-daedalus' (controller keeps building toward the 30-aug/$100b invite)
 *   - favor over the gate -> BUY the 2.5M rep with cash; no grinding at all
 *   - rep already clears the gate -> INSTALL to bank the favor, then buy (see 'favor-bank' below)
 *   - in Daedalus, rep < 2.5M -> grind Daedalus hacking work (also feeds hacking XP)
 *   - rep >= 2.5M      -> buy the Red Pill, then installAugmentations (locks it in; resets stats)
 *   - Red Pill queued  -> install it (covers a buy that didn't install in the same tick)
 *   - Red Pill installed, hacking < req -> re-climb: hacking-track faction work for XP
 *
 * CRUCIAL: this NEVER installs non-Red-Pill augs. An install wipes current faction rep, which would throw
 * away the Daedalus grind — so the controller stops the general augs/install loop while this runs.
 *
 * It writes ENDGAME_FILE (free) so the controller can gate on `redPillInstalled` without paying for the
 * Singularity reads itself. `redPillInstalled` is written OPTIMISTICALLY true right before an install commits,
 * so after the reset+relaunch the controller stays in close mode instead of falling back to building.
 *
 * Run: `run /singularity/redpill.js`
 */
const REV = 'v4';
const RED_PILL = 'The Red Pill';
const DAEDALUS = 'Daedalus';

export async function main(ns: NS) {
  // +6.2 GB over v1 for the donation path: getFactionFavor 1 + getFavorToDonate 0.1 + donateToFaction 5
  // + getServerMoneyAvailable 0.1. v4 adds the favor bank's exec 1.3 + isRunning 0.1 = 32.4, call it 33.
  if (!reserveOk(ns, 42, 33)) return;
  const s = sing(ns);
  const hack = ns.getHackingLevel();
  // Key the record to THIS node instance. lastNodeReset is stable across aug installs but changes on entering
  // a BitNode — so the controller trusts `redPillInstalled` across the Red-Pill install/relaunch, yet a fresh
  // run (even of the same BitNode number) sees a mismatch and discards the stale latch. See readEndgame.
  const nodeReset = ns.getResetInfo().lastNodeReset;

  const installed = new Set(s['getOwnedAugmentations'](false)); // installed only (not queued)
  const queued = new Set(s['getOwnedAugmentations'](true)); // installed + purchased-but-not-installed
  const inDaedalus = ns.getPlayer().factions.includes(DAEDALUS);

  // `provenReq: true` on EVERY write: close mode is the only thing that execs this script, and close mode is
  // only ever entered by reaching the daemon hacking req (or by already holding the Red Pill). So by the time
  // we write anything, the proof has happened — and stamping it here is what lets the controller stay in close
  // mode after the favor-bank install below resets hacking to 1.
  const write = (phase: string, redPillInstalled: boolean, detail: string, extra: Record<string, unknown> = {}) =>
    ns.write(
      ENDGAME_FILE,
      JSON.stringify({
        rev: REV,
        nodeReset,
        redPillInstalled,
        provenReq: true,
        inDaedalus,
        hack,
        phase,
        detail,
        ...extra,
      }),
      'w',
    );

  // Red Pill already installed -> the daemon is now in the network. Nothing to grind; if hacking is still
  // below the daemon req (the post-install re-climb), spend the slot on hacking-track faction work for XP.
  if (installed.has(RED_PILL)) {
    if (!s['workForFaction'](DAEDALUS, 'hacking', true)) s['workForFaction'](DAEDALUS, 'field', true);
    write('reclimb', true, `Red Pill installed — re-climbing hacking ${hack}, faction work for XP`);
    ns.tprint(`=== redpill ${REV} — Red Pill in; re-climbing (hacking ${hack}) ===`);
    return;
  }

  // Red Pill purchased but not yet installed -> install it now (locks it in; resets stats, wires in the daemon).
  if (queued.has(RED_PILL)) {
    write('installing', true, 'Red Pill purchased — installing to lock it in');
    ns.tprint(`=== redpill ${REV} — installing (Red Pill queued) ===`);
    s['installAugmentations']('/bootstrap.js');
    return;
  }

  // Not in Daedalus yet -> can't grind the Red Pill. The controller keeps building toward the invite
  // (30 augs installed / $100b / hacking 2500) and auto-joins when it lands.
  if (!inDaedalus) {
    write('await-daedalus', false, 'not in Daedalus yet — need 30 augs / $100b / hacking 2500');
    ns.tprint(`=== redpill ${REV} — not in Daedalus; controller keeps building ===`);
    return;
  }

  // In Daedalus. Grind its rep to the Red Pill requirement, then buy + install.
  const rep = s['getFactionRep'](DAEDALUS);
  const repReq = s['getAugmentationRepReq'](RED_PILL);
  const repStr = `${ns.format.number(rep)}/${ns.format.number(repReq)}`;
  if (rep >= repReq) {
    if (s['purchaseAugmentation'](DAEDALUS, RED_PILL)) {
      write('installing', true, `Red Pill rep met (${repStr}) — bought; installing`, { rep, repReq });
      ns.tprint(`=== redpill ${REV} — Red Pill bought; installing ===`);
      s['installAugmentations']('/bootstrap.js');
      return;
    }
    write('grind', false, `rep met (${repStr}) but purchase failed — retrying`, { rep, repReq });
    ns.tprint(`WARN redpill: rep met but purchaseAugmentation('${DAEDALUS}','${RED_PILL}') returned false.`);
    return;
  }

  // BUY THE REP. If Daedalus favor has cleared the donation gate, the remaining 2.5M is a cash purchase
  // rather than hours of faction work — the single biggest time saving in the close-out. Daedalus offers
  // hacking + field work (FactionInfo), so it is donatable; it can never be a gang faction, so no gang
  // check is needed here. `repwork.ts` gets the favor there during BUILD mode via
  // `strat.rep.redPillFavorRoute`; if it did not finish in time, the favor-bank branch below does it here.
  const strat = liveStrategy(ns, ns.getResetInfo().currentNode);
  if (strat.rep.donate && s['getFactionFavor'](DAEDALUS) >= ns.getFavorToDonate()) {
    const rate = donationRate(ns, s, DAEDALUS);
    if (rate > 0) {
      // Re-read: the probe itself moved rep. 1.001 covers float error so we never land a rep short.
      const cost = ((repReq - s['getFactionRep'](DAEDALUS)) * 1.001) / rate;
      if (cost <= ns.getServerMoneyAvailable('home') && s['donateToFaction'](DAEDALUS, cost)) {
        write('buying', false, `donated ${ns.format.number(cost)} for the Red Pill's rep`, { rep, repReq });
        ns.tprint(
          `=== redpill ${REV} — bought ${ns.format.number(repReq - rep)} rep for ${ns.format.number(cost)} ===`,
        );
        if (s['purchaseAugmentation'](DAEDALUS, RED_PILL)) {
          write('installing', true, 'Red Pill bought with donated rep — installing');
          s['installAugmentations']('/bootstrap.js');
          return;
        }
      } else {
        ns.tprint(`INFO  redpill: Red Pill rep would cost ${ns.format.number(cost)} — not affordable yet.`);
      }
    }
  }

  // FAVOR BANK. We hold enough Daedalus rep to clear the donation gate, but favor is awarded ONLY at an
  // install (`Faction.prestigeAugmentation` converts rep -> favor and zeroes the rep). So the rep sitting in
  // the bar right now is worth more spent as favor than continued: crossing turns the remaining 2.5M from
  // hours of faction work into a single cash purchase, and the gang funds that in minutes.
  //
  // Installing here looks destructive — it resets hacking to ~1 — but that climb was ALREADY forfeit: buying
  // the Red Pill is followed immediately by `installAugmentations` above, which resets hacking anyway. So the
  // real comparison is "grind 2.5M rep by hand, then reset" against "reset now, buy the rep, then reset" —
  // and the second also banks every queued aug, making the one mandatory re-climb faster than the climb we
  // already completed. Requires `provenReq` in the controller, or this bounces back to BUILD mode and
  // re-climbs BEFORE buying, wasting the very climb this is trying to save.
  //
  // Guarded on rep ALREADY crossing the gate: `repToReachFavor` is cumulative-rep-for-favor, so this fires
  // only when the install is certain to leave Daedalus donatable. Note rep is zeroed by it — the donation
  // afterwards is for the FULL repReq, not the remainder.
  const favor = s['getFactionFavor'](DAEDALUS);
  const minFavor = ns.getFavorToDonate();
  if (strat.rep.donate && strat.rep.redPillFavorRoute && favor < minFavor && repToReachFavor(favor, minFavor) <= rep) {
    write('favor-bank', false, `installing to bank Daedalus favor — ${repStr} rep clears the ${minFavor} gate`, {
      rep,
      repReq,
    });
    ns.tprint(
      `=== redpill ${REV} — banking Daedalus favor: installing so the remaining ` +
        `${ns.format.number(repReq)} rep becomes a cash purchase ===`,
    );
    // Delegate to install.js --force rather than calling installAugmentations here. In close mode NOTHING
    // has been bought, so the queue is empty — and installAugmentations no-ops on an empty queue without
    // throwing or reporting, which made this branch print and retry forever. install.js runs the contract
    // sweep, the --preinstall spend-down (which is what fills the queue, and turns a cash pile that the
    // reset would zero into augs + NeuroFlux levels) and the home dump first, then installs. Those extra
    // multipliers land in exactly the run that has to re-climb, so this is also the better reset.
    const pid = ns.exec('/singularity/install.js', 'home', 1, '--force');
    if (pid === 0) {
      ns.tprint('WARN redpill: could not launch install.js for the favor bank (home full) — retrying next tick.');
      return;
    }
    while (ns.isRunning(pid)) await ns.sleep(500);
    // Reaching here means install.js declined (it prints why) — the reset would have killed us instead.
    return;
  }

  // Still grinding. Hacking work feeds hacking XP too, so we stay above the daemon req during the grind.
  if (!s['workForFaction'](DAEDALUS, 'hacking', true)) s['workForFaction'](DAEDALUS, 'field', true);
  write('grind', false, `grinding Daedalus rep ${repStr} for the Red Pill`, { rep, repReq });
  ns.tprint(`=== redpill ${REV} — grinding Daedalus rep ${repStr} for the Red Pill ===`);
}
