import type { NS } from '@ns';
import { liveStrategy } from '../lib/bitnode';
import { repToReachFavor } from '../lib/favor';
import { INSTALL_FILE } from '../lib/ports';
import { sing, reserve, reserveOk, donationRate } from './api';

/**
 * P2 augment buyer (Singularity), one-shot. Three passes:
 *
 *   1. DONATE — buy faction rep with money for augs whose REP we lack, cheapest total-unlock-cost
 *      (donation + price) first, so a pass maximizes augs-per-dollar. Skipped entirely when no faction
 *      is donatable, which is the normal case until a run has banked ~462.5k rep somewhere.
 *   2. BUY    — every aug we now have the rep + prereqs for, MOST-EXPENSIVE-FIRST so the 1.9x
 *      per-queued-aug escalation lands on the cheap ones.
 *   3. NFG    — `--preinstall` ONLY: soak up every remaining dollar in NeuroFlux levels.
 *
 * Keeps `strat.augs.cashReserve` liquid — except on the final pass, where there is nothing to keep it for.
 *
 * ## Why NeuroFlux is not part of the periodic pass
 *
 * `getGenericAugmentationPriceMultiplier()` is `1.9 ^ queuedAugmentations.length`, and `queueAugmentation`
 * exempts NFG from its duplicate check — so EVERY NFG level is its own queue entry and multiplies the
 * price of every real aug bought afterwards by 1.9. Five levels is 24.8x; ten is 613x. Buying NFG on the
 * 120s timer therefore prices genuine augmentations out of reach for the rest of the install cycle.
 *
 * So NFG is bought exactly once per cycle, by install.js, immediately before it resets — the one moment
 * when inflating the queue costs nothing because nothing else will be bought. Rep requirements are
 * unaffected (only `moneyCost` takes the multiplier), so donations are never distorted by this.
 *
 * ## It publishes the install decision
 *
 * This script already pays ~30 GB to enumerate every faction's augs, prices and rep, so it also answers
 * the two questions install.js would otherwise have to re-pay for: is anything still purchasable
 * (`stalled`), and would an install now carry a faction over the donation favor gate (`favorCrossings`).
 * Written to INSTALL_FILE, read for free. See `lib/ports.ts` for the fail-safe contract.
 *
 * ## Why donations get a pass of their own
 *
 * Above `ns.getFavorToDonate()` favor, rep stops being a time cost and becomes a money cost. A mature run
 * with an idle cash pile converts it straight into aug unlocks instead of spending hours of the action
 * slot on faction work. `repwork.ts` is the other half of the fix: it skips factions this pass can buy
 * out, so the slot goes to a faction that money CANNOT help — which is what actually compounds.
 *
 * ## The trap: donated rep is a per-cycle consumable
 *
 * Installing resets faction rep to 0, converting it to favor (`Faction.prestigeAugmentation`). Rep bought
 * and not spent before the next install is money burned. So this script donates and buys in the SAME
 * pass, and never donates for an aug it cannot also afford to purchase right now.
 *
 * ## RAM: raised lazily, on purpose
 *
 * The buy pass costs ~30 GB; the donation calls add ~9 GB (BN4, x1). `dynamicRamUsage` only charges for
 * functions actually CALLED, so reserving the full ~39 GB up front would make this script bail on a small
 * home in runs that were never going to donate anyway. Instead: reserve for the buy pass, raise only when
 * a donation is genuinely on the table, and fall through to buying if the raise doesn't fit. `ramOverride`
 * is monotonic, so the raise is safe and never has to be undone.
 *
 * Run: `run /singularity/augs.js`               periodic pass — real augs only
 *      `run /singularity/augs.js --preinstall`  final pass — spend everything, then NFG (install.js does this)
 */
const REV = 'v4';
const NFG = 'NeuroFlux Governor';
/** Owned by redpill.ts, never bought here. See `offers()` for why. */
const RED_PILL = 'The Red Pill';

/** Buy-pass reservation: base 1.6 + getResetInfo 1 + getOwnedAugmentations 5 + getPlayer 0.5 +
 * getFactionRep 1 + getAugmentationsFromFaction 5 + getAugmentationRepReq 2.5 + getAugmentationPrereq 5
 * + getAugmentationPrice 2.5 + purchaseAugmentation 5 + getServerMoneyAvailable 0.1 = 29.2 GB. */
const BUY_GB = 30;
/** ...plus the donation calls: getFavorToDonate 0.1 + gang.getGangInformation 2 + getFactionFavor 1 +
 * getFactionWorkTypes 1 + donateToFaction 5 = 38.3 GB. These are the BN4 x1 Singularity rates; a node
 * running on SF-4.1/4.2 pays 16x/4x and needs a far bigger host for any of this. */
const DONATE_GB = 39;
/** ...and getAugmentationStats on top of whichever of those two ran, to price the install decision. */
const STATS_GB = 5;

/** The `Multipliers` fields that make an augmentation worth buying DURING the karma grind. Homicide
 * success is `Σ(weight × stat) / 975 / difficulty × mult` with STR and DEF weighted 2 (verified: the
 * field is `defense_success_weight`, not dexterity), so those two dominate — but crime_success and
 * crime_money move the same loop directly, and agi/dex still contribute at weight 1.
 *
 * String literals, and read by bracket access at the call site: the static RAM parser searches its cost
 * table by BARE NAME at any depth, so `stats.strength` on a plain return value would bill a real API. */
const COMBAT_STATS = ['strength', 'defense', 'dexterity', 'agility', 'crime_success', 'crime_money'] as const;

/** Calibration donation. Big enough to read a clean rep delta, small enough to be noise against any cash
 * pile that makes donating worthwhile in the first place. */
const PROBE = 1e6;
/** Ask for a hair more rep than the gap, so float error can never leave us one rep short of the buy. */
const GAP_SLACK = 1.001;
/** Backstop on the NFG ladder — it is infinite by design, so never trust the budget alone to end it. */
const NFG_MAX_PASS = 500;

export async function main(ns: NS) {
  const flags = ns.flags([['preinstall', false]]);
  /** FINAL pass, run by install.js in the moments before it resets. Two things change, both because an
   * install sets money to $1,000 (`PlayerObjectGeneralMethods.prestigeAugmentation`): every dollar not
   * spent right now is about to be DESTROYED, so the cash reserve and the donation budget fraction are
   * both suspended, and the NeuroFlux ladder runs to soak up whatever is left. */
  const final = flags['preinstall'] as boolean;

  if (!reserveOk(ns, BUY_GB + 10, BUY_GB)) return;
  const s = sing(ns);
  const info = ns.getResetInfo();
  const strat = liveStrategy(ns, info.currentNode);
  const money = () => ns.getServerMoneyAvailable('home');
  /** Liquidity to protect — nothing, on the final pass. */
  const reserveCash = final ? 0 : strat.augs.cashReserve;

  const owned = new Set(s['getOwnedAugmentations'](true)); // includes purchased-but-not-installed (queued)
  const factions = ns.getPlayer().factions;

  /** Unowned, prereqs-met augs `f` sells, with the rep still missing. `gap <= 0` means buyable now.
   *
   * NFG is excluded because it is not a one-time aug — it has its own ladder pass below. THE RED PILL is
   * excluded because `redpill.ts` owns it: it is $0 but 2.5M rep, so a donation pass would happily spend
   * ~$1.67t on it mid-build, install it, and wire w0r1d_d43m0n into the network long before the endgame
   * is ready for that. Excluding it here also keeps it OUT of the queue while other augs are being bought
   * — queuing it would add 1 to the `1.9^queued` exponent and inflate every real aug for no gain, since
   * its own price is 0 and can never escalate. It is always the last thing bought, by design. */
  const offers = (f: string) => {
    const rep = s['getFactionRep'](f);
    return s['getAugmentationsFromFaction'](f)
      .filter(
        (a) => a !== NFG && a !== RED_PILL && !owned.has(a) && s['getAugmentationPrereq'](a).every((p) => owned.has(p)),
      )
      .map((a) => ({ aug: a, gap: s['getAugmentationRepReq'](a) - rep }));
  };

  // ---------------------------------------------------------------- 1. DONATE
  /** Rep bought per dollar. From src/Faction/formulas/donation.ts:
   *     rep = amount / 1e6 * player.mults.faction_rep * BitNodeMultipliers.FactionWorkRepGain
   * `FactionWorkRepGain` is unreadable without SF-5 (`getBitNodeMultipliers`), so rather than hardcode
   * BN4's 0.75 we MEASURE the rate: one probe donation, read the rep delta. There is no per-faction term
   * in that formula, so a single probe calibrates the whole pass — and it stays correct in any BitNode,
   * and under any faction_rep augment we install mid-run. 0 means "not calibrated / unusable". */
  let rate = 0;
  /** What the aug pass left unspent — the only thing the NFG ladder is allowed to consume. */
  let repBudget = 0;
  /** Factions we may legally donate to: not the gang's, favor gate met, and offering at least one work
   * type. Empty unless the donate pass ran, which is what keeps the NFG pass from calling into it. */
  let donatable: string[] = [];
  let donated = 0;
  let unlocked = 0;
  /** Factions the rep we are HOLDING would carry over the donation favor gate at the next install — the
   * install trigger's most valuable signal. Only computable inside the donate block (it needs favor), and
   * only meaningful when donations are enabled at all, so [] elsewhere is the correct fail-safe. */
  let favorCrossings: string[] = [];

  // Only pay for the donation-side API calls if a donation could actually happen.
  const donateRan = strat.rep.donate && reserve(ns, DONATE_GB + 6) >= DONATE_GB;
  if (donateRan) {
    const gangFaction = ns.gang.inGang() ? ns.gang.getGangInformation().faction : '';
    const minFavor = ns.getFavorToDonate();
    donatable = factions.filter(
      (f) => f !== gangFaction && s['getFactionFavor'](f) >= minFavor && s['getFactionWorkTypes'](f).length > 0,
    );

    // Which factions would cross the gate if we installed right now? Only counts where there is still
    // something to buy there afterwards — crossing at a faction whose augs we already own buys nothing.
    // The gang faction is excluded: its rep is never donatable however much favor it accrues.
    favorCrossings = factions.filter((f) => {
      if (f === gangFaction || s['getFactionFavor'](f) >= minFavor) return false; // already over, or ineligible
      if (repToReachFavor(s['getFactionFavor'](f), minFavor) > s['getFactionRep'](f)) return false;
      // The Red Pill IS counted here, unlike everywhere else in this file: it is the entire reason to push
      // Daedalus over the gate, and excluding it would make Daedalus — the one crossing that matters most
      // — look worthless. NFG is excluded because every faction sells it, which would make every faction a
      // crossing.
      return s['getAugmentationsFromFaction'](f).some((a) => a !== NFG && !owned.has(a));
    });

    // An aug sold by several factions only needs unlocking at the CHEAPEST one — and not at all if some
    // faction already has the rep for it (the buy pass will take it there for free).
    const readyAnywhere = new Set<string>();
    for (const f of factions) for (const o of offers(f)) if (o.gap <= 0) readyAnywhere.add(o.aug);

    const best = new Map<string, { faction: string; gap: number }>();
    for (const f of donatable) {
      for (const o of offers(f)) {
        if (o.gap <= 0 || readyAnywhere.has(o.aug)) continue;
        const prev = best.get(o.aug);
        if (!prev || o.gap < prev.gap) best.set(o.aug, { faction: f, gap: o.gap });
      }
    }

    // Calibrate against a faction we actually intend to use — but only if this pass has something to
    // spend on. With no gated aug and no NFG ladder to feed, the probe would burn PROBE every cycle
    // to price a purchase we were never going to make.
    const probeAt = best.size > 0 ? [...best.values()][0].faction : strat.rep.donateNeuroFlux ? donatable[0] : '';
    if (probeAt && money() - PROBE >= reserveCash) {
      rate = donationRate(ns, s, probeAt, PROBE);
      if (rate > 0) {
        donated += PROBE;
        ns.tprint(
          `  donate: ${ns.format.number(rate * 1e9)} rep per $1b (calibrated at ${probeAt}, favor gate ${minFavor})`,
        );
      } else {
        ns.tprint('WARN  augs: donation probe failed — skipping the donate pass.');
      }
    }

    if (rate > 0) {
      // `donateBudgetFraction` of surplus IS the joint budget: what it does not spend is what the buy pass
      // has left for the aug prices this rep is unlocking. On the final pass that trade-off is gone —
      // unspent cash is destroyed by the reset seconds from now — so the fraction goes to 1.
      const fraction = final ? 1 : strat.rep.donateBudgetFraction;
      repBudget = Math.max(0, (money() - reserveCash) * fraction - donated);

      // Cheapest total unlock cost first — maximizes augs unlocked per dollar. (The buy pass re-sorts by
      // price descending for the escalation; the two orderings are independent and both apply.)
      const wanted = [...best.entries()]
        .map(([aug, b]) => ({ aug, ...b, cost: (b.gap * GAP_SLACK) / rate, price: s['getAugmentationPrice'](aug) }))
        .sort((a, b) => a.cost + a.price - (b.cost + b.price));

      for (const w of wanted) {
        if (w.cost > repBudget) continue;
        // Never buy rep for an aug we then cannot afford — the next install would wipe that rep unspent.
        if (money() - w.cost - w.price < reserveCash) continue;
        if (!s['donateToFaction'](w.faction, w.cost)) continue;
        repBudget -= w.cost;
        donated += w.cost;
        unlocked++;
        ns.tprint(
          `  unlocked: ${w.aug} — donated ${ns.format.number(w.cost)} to ${w.faction} for ${ns.format.number(w.gap)} rep`,
        );
      }
    }
  }

  // ------------------------------------------------------------------- 2. BUY
  // Buyable = rep met + prereqs owned + not already owned/queued. Dedupe an aug offered by many factions.
  type Buy = { faction: string; aug: string; price: number };
  const buyable: Buy[] = [];
  for (const f of factions) {
    for (const o of offers(f)) {
      if (o.gap > 0 || buyable.some((b) => b.aug === o.aug)) continue;
      buyable.push({ faction: f, aug: o.aug, price: s['getAugmentationPrice'](o.aug) });
    }
  }
  buyable.sort((a, b) => b.price - a.price);

  // FOCUS FILTER. While the karma grind owns the action slot, buy ONLY combat/crime augs.
  //
  // Not merely a preference — buying a hacking aug mid-grind is actively harmful.
  // `getGenericAugmentationPriceMultiplier()` is `1.9 ^ queuedAugmentations.length`, so every queued
  // hacking aug multiplies the price of the combat augs we actually want by 1.9. And the install that
  // banks them zeroes combat levels (`prestigeAugmentation`), slowing homicide, for augs that do nothing
  // for karma. Combat augs pay both ways: homicide success is Σ(weight × stat) with STR/DEF weighted 2.
  //
  // The phase is read live rather than configured — `strategyFor` has no idea whether the gang exists
  // yet. This is what `augs.focus` was always supposed to mean; it was declared and never read.
  const grinding = strat.route.primary === 'gang' && !ns.gang.inGang();
  if (grinding && buyable.length > 0) {
    // getAugmentationStats is 5 GB on top of the buy pass. Raise lazily and FAIL OPEN: an unfiltered buy
    // is merely suboptimal, whereas a filter that silently matches nothing would stall every purchase for
    // the rest of the grind. `reserve()` is raise-only, so this can never shrink what we already hold.
    if (reserve(ns, BUY_GB + STATS_GB + 4) >= BUY_GB + STATS_GB) {
      const isCombat = (aug: string): boolean => {
        const st = s['getAugmentationStats'](aug) as unknown as Record<string, number>;
        // Bracket access throughout: the static parser bills a bare property name that collides with any
        // NS API at any depth, and `strength`/`agility` and friends do.
        return COMBAT_STATS.some((k) => (st[k] ?? 1) !== 1);
      };
      const combatOnly = buyable.filter((b) => isCombat(b.aug));
      // An EMPTY result is respected, not treated as an error: nothing combat-relevant is purchasable, so
      // the right move is to buy nothing and keep the queue (and combat stats) clean until the gang founds.
      // install.js cannot fire on an empty queue, so this cannot trigger a reset either.
      ns.tprint(
        `  focus: karma grind — ${combatOnly.length}/${buyable.length} buyable augs are combat/crime; ` +
          `holding the rest until the gang founds`,
      );
      buyable.length = 0;
      buyable.push(...combatOnly);
    } else {
      ns.print('focus: could not afford getAugmentationStats — buying unfiltered this pass.');
    }
  }

  const bought: string[] = [];
  let spentOnAugs = 0;
  for (const b of buyable) {
    // Re-fetch the live price: earlier buys raise the escalation for later ones.
    const price = s['getAugmentationPrice'](b.aug);
    if (money() - price < reserveCash) continue;
    if (s['purchaseAugmentation'](b.faction, b.aug)) {
      owned.add(b.aug);
      bought.push(b.aug);
      spentOnAugs += price;
      ns.tprint(`  bought: ${b.aug} from ${b.faction} (${ns.format.number(price)})`);
    }
  }

  // STALLED: is there anything left worth waiting for? Re-enumerated AFTER the buys, so it reflects the
  // escalated prices this pass just created. "Nothing purchasable" covers both drained factions and augs
  // we simply cannot afford — and both mean the same thing to the install trigger: waiting gains nothing,
  // because `1.9^queued` and the money that would beat it only reset at an install.
  let stalled = true;
  for (const f of factions) {
    for (const o of offers(f)) {
      if (o.gap > 0) {
        // Rep-gated: still worth waiting for only if we could donate our way to it.
        if (
          rate > 0 &&
          donatable.includes(f) &&
          (o.gap * GAP_SLACK) / rate + s['getAugmentationPrice'](o.aug) <= money() - reserveCash
        )
          stalled = false;
        continue;
      }
      if (money() - s['getAugmentationPrice'](o.aug) >= reserveCash) stalled = false;
    }
  }

  // ------------------------------------------------------------------- 3. NFG
  // FINAL PASS ONLY (see the header): every queued NFG level multiplies real augs by 1.9, so this runs
  // once, with the reset seconds away and no further purchase left to inflate.
  //
  // Buy from the highest-rep faction that still sells it, while affordable. Its rep requirement and price
  // both climb ~1.14x per purchase, so re-evaluate every iteration. When `donateNeuroFlux` is on and no
  // faction has the rep any more, buy the smallest remaining gap out of whatever the aug pass left — this
  // is the sink that turns a cash pile the reset would otherwise DESTROY into permanent multipliers.
  let nfg = 0;
  let nfgDonated = 0;
  if (final && strat.augs.neuroFluxDump) {
    let budget = strat.rep.donateNeuroFlux && rate > 0 ? repBudget : 0;
    const nfgSellers = factions.filter((f) => s['getAugmentationsFromFaction'](f).includes(NFG));
    const nfgDonatable = nfgSellers.filter((f) => donatable.includes(f));

    for (let i = 0; i < NFG_MAX_PASS; i++) {
      const req = s['getAugmentationRepReq'](NFG);
      const price = s['getAugmentationPrice'](NFG);

      let seller = nfgSellers
        .filter((f) => s['getFactionRep'](f) >= req)
        .sort((a, b) => s['getFactionRep'](b) - s['getFactionRep'](a))[0];

      if (!seller && budget > 0) {
        // Cheapest remaining gap among sellers we may donate to. Recomputed per level — the gap grows.
        const cand = nfgDonatable
          .map((f) => ({ faction: f, cost: ((req - s['getFactionRep'](f)) * GAP_SLACK) / rate }))
          .filter((c) => c.cost > 0 && c.cost <= budget)
          .sort((a, b) => a.cost - b.cost)[0];
        if (cand && money() - cand.cost - price >= reserveCash && s['donateToFaction'](cand.faction, cand.cost)) {
          budget -= cand.cost;
          nfgDonated += cand.cost;
          seller = cand.faction;
        }
      }

      if (!seller) break;
      if (money() - price < reserveCash) break;
      if (!s['purchaseAugmentation'](seller, NFG)) break;
      nfg++;
    }
  }

  const spend = donated + nfgDonated;

  // ------------------------------------------------- publish the install decision (free: read + write)
  // Skipped on the final pass — install.js has already decided by then, and rewriting the record while it
  // resets would only leave a confusing artefact behind.
  if (!final) {
    const prior = readAdvice(ns, info.lastAugReset);
    // `stalled` is deliberately a STREAK, not a snapshot. Income is continuous, so "cannot afford anything
    // this second" is normal noise a minute before the gang delivers — installing on it would reset the run
    // every time cash dipped. Requiring it to hold across consecutive passes means we only call it stalled
    // when it genuinely is. Any pass that buys or unlocks something breaks the streak outright.
    const progressed = bought.length > 0 || unlocked > 0;

    // The queue, and what installing it would do to the HACKING multiplier.
    //
    // `hackMultGain` is what makes the install decision intelligent rather than a count. `expForSkill` is
    // exponential in `level / mult`, so knowing the post-install multiplier lets the controller compare
    // "finish this climb" against "install and re-climb from zero" as two times, and pick the smaller. A
    // count can never express that: late in a run three more augs may be unreachable while the one already
    // queued is worth 100x. Multipliers stack multiplicatively (`mergeMultipliers`), and NFG's per-level
    // mults apply once per queued LEVEL — which is exactly one queue entry each, so a plain product is right.
    //
    // 1 is the fail-safe: "no known gain", on which the controller will never release the install hold.
    // getAugmentationStats is a further 5 GB, so raise for it only when there is something to measure, and
    // account for whether the donation pass already spent its share of the reservation.
    const queuedNames = s['getOwnedAugmentations'](true).slice(s['getOwnedAugmentations'](false).length);
    let hackMultGain = 1;
    const statsNeed = (donateRan ? DONATE_GB : BUY_GB) + STATS_GB;
    if (queuedNames.length > 0 && reserve(ns, statsNeed + 4) >= statsNeed) {
      // Bracket access on 'hacking': the static parser bills a bare property name that collides with an API.
      for (const a of queuedNames) hackMultGain *= s['getAugmentationStats'](a)['hacking'] || 1;
    }

    ns.write(
      INSTALL_FILE,
      JSON.stringify({
        rev: REV,
        augReset: info.lastAugReset,
        // install.js recomputes the count itself — it must never trust a file for a destructive decision —
        // but publishing it lets the CONTROLLER show "augs 2/8" in its status line for free.
        realQueued: queuedNames.filter((a) => a !== NFG).length,
        hackMultGain,
        stalledPasses: stalled && !progressed ? prior.stalledPasses + 1 : 0,
        favorCrossings,
        spent: prior.spent + spentOnAugs + spend,
        detail:
          `${bought.length} bought, ${unlocked} unlocked` +
          (stalled ? ', nothing further purchasable' : '') +
          (favorCrossings.length ? `, favor crossing: ${favorCrossings.join(', ')}` : ''),
      }),
      'w',
    );
  }

  ns.tprint(
    `=== augs ${REV}${final ? ' [final]' : ''} — bought ${bought.length} aug(s)` +
      (final ? ` + ${nfg}x ${NFG}` : '') +
      (spend > 0 ? ` · donated ${ns.format.number(spend)} for rep (${unlocked} unlock(s))` : '') +
      ' ===',
  );
}

/** Prior record for THIS install cycle, or a zeroed one. Fail-safe: anything unreadable, malformed or from
 * a previous cycle reads as "no streak, no crossings, nothing spent" — never as a reason to install. */
function readAdvice(ns: NS, augReset: number): { stalledPasses: number; spent: number } {
  const zero = { stalledPasses: 0, spent: 0 };
  try {
    const raw = ns.read(INSTALL_FILE);
    if (!raw) return zero;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o['augReset'] !== augReset) return zero; // written before the last install — not ours
    return {
      stalledPasses: typeof o['stalledPasses'] === 'number' ? o['stalledPasses'] : 0,
      spent: typeof o['spent'] === 'number' ? o['spent'] : 0,
    };
  } catch {
    return zero;
  }
}
