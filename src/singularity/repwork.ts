import type { NS } from '@ns';
import { liveStrategy } from '../lib/bitnode';
import { repToReachFavor } from '../lib/favor';
import { sing, reserve, reserveOk } from './api';
import { augValue, valuePerRep, type MultBag } from '../lib/aug-value';

/**
 * P2 action-slot work (Singularity), one-shot. Priority:
 *   1. MEGACORP PATH — walk `companyTargets` in order and process each FULLY before the next: if we're not
 *      in its faction, grind the company job to unlock it; once in, grind its FACTION rep for its own augs
 *      (e.g. Bachman -> SmartJaw). Unlocking a megacorp is only worth it for its augs, so collect them
 *      before moving on. A target whose augs we already own (rep-boosters are sold by many factions) is
 *      skipped entirely.
 *   2. FACTION rep — the remaining joined factions with unowned rep-gated augs, skipping the gang faction
 *      (its rep accrues passively). Only reached once the megacorp path is exhausted.
 * Prefers hacking work (also grows hacking XP). Work persists after this exits; the controller re-runs it.
 *
 * ## The action slot is for rep money CANNOT buy
 *
 * Two rules follow from `donateToFaction`, and both are about not wasting the slot:
 *
 * - **Skip donatable factions.** Above `ns.getFavorToDonate()` favor, a faction's rep is purchasable, and
 *   `augs.ts` buys it in the same cycle it spends it. Grinding such a faction by hand is the exact waste
 *   this rule exists to kill — the slot belongs on a faction money cannot help.
 * - **The favor gate is priced, not privileged** (`strat.rep.favorPush`). Favor is awarded only at an
 *   install, which converts rep to favor and zeroes the rep; crossing turns that faction's remaining rep
 *   from a time cost into a money cost for the rest of the BitNode. That is worth something, so it
 *   competes — as `gatedValue / gateGap`, against the best single aug's `augValue / repGap`, in the same
 *   units. Whichever is the better buy wins.
 *
 *   It used to be a PRIORITY TIER that outranked value outright, and BN1 showed why that fails: with no
 *   faction yet at 150 favor, every candidate was in push mode, the tiebreak degenerated to "nearest to
 *   crossing", and the slot went to OmniTek (4 augs, best `hacking x1.20`) while BitRunners sat with 10
 *   augs including `hacking x1.30` about as far away. Value was never consulted at all.
 *
 * Run: `run /singularity/repwork.js`
 */
const REV = 'v12';
/** Default order: hacking work pays the most rep for a hacking-built character, and its XP feeds the
 * endgame climb. Swapped for the combat order below while a combat gate is open. */
const WORK_TYPES = ['hacking', 'security', 'field'];
/** Field and security work pay rep AND combat experience. Same action slot, same rep — just a different
 * flavour of XP alongside it. */
const COMBAT_WORK_TYPES = ['field', 'security', 'hacking'];
const DAEDALUS = 'Daedalus';

export async function main(ns: NS) {
  // ~28.9 GB: v5's 27.6 + getFactionFavor 1 + getFavorToDonate 0.1 + the gate's money 0.1 / hackingLevel 0.05.
  if (!reserveOk(ns, 40, 29)) return;
  // +5 GB for getAugmentationStats, which is what lets the ranking below use VALUE instead of aug count.
  // Raised separately and allowed to fail: `reserve()` is raise-only, so a refusal leaves the 29 GB intact
  // and we fall back to the old count-based ordering. Ranking slightly wrong beats not running at all on a
  // full home — this is the same fail-open shape as the donation raise in augs.ts.
  const statsOk = reserve(ns, 40) >= 34;
  const s = sing(ns);
  const strat = liveStrategy(ns, ns.getResetInfo().currentNode);
  const owned = new Set(s['getOwnedAugmentations'](true));
  const inFactions = new Set<string>(ns.getPlayer().factions);
  const gangFaction = ns.gang.inGang() ? ns.gang.getGangInformation().faction : '';
  const minFavor = ns.getFavorToDonate();

  /** Money can buy this faction's rep outright, so the action slot has no business here. No
   * `getFactionWorkTypes` check (1 GB saved): a faction we would consider WORKING offers work by
   * definition — if it somehow doesn't, `workForFaction` just fails and we fall through to the next. */
  const donatable = (f: string): boolean =>
    strat.rep.donate && f !== gangFaction && s['getFactionFavor'](f) >= minFavor;

  /** Does `faction` have an unowned aug we still lack the rep to buy? */
  const repGatedLeft = (faction: string): boolean => {
    const rep = s['getFactionRep'](faction);
    return s['getAugmentationsFromFaction'](faction).some((a) => !owned.has(a) && s['getAugmentationRepReq'](a) > rep);
  };
  // COMBAT GATE — NO GYM. Gym is a P1 tool: it buys stats with pure action-slot time and pays no rep, which
  // is a bad trade once the run is earning. Instead, while a combat-gated faction is still locked, we take
  // the SAME faction work we were going to do anyway and pick the work type that also pays combat XP.
  //
  // That is enough because of how the skill curve works. An install zeroes combat EXP as well as the levels
  // (`prestigeAugmentation` sets `exp.strength = 0`), so a cycle starts at `floor(mult * 0.99)` — multipliers
  // alone never reach the gate. But `expForSkill` is exponential in `level / mult`, so with combat
  // multipliers stacked from augs the EXP needed collapses: at mult 20, level 1200 wants ~2.8k exp, which
  // field work delivers incidentally. Stack the augs, and the gate stops being something we spend time on.
  const gate = strat.rep.combatGate;
  const combatShort =
    gate.faction !== '' &&
    !inFactions.has(gate.faction) &&
    ns.getHackingLevel() >= gate.hacking &&
    ns.getServerMoneyAvailable('home') >= gate.money &&
    (() => {
      // Bracket access on the skill names: the static parser bills a bare property name that collides with
      // an NS API, searching its cost table recursively by name regardless of namespace.
      const sk = (ns.getPlayer() as unknown as { skills: Record<string, number> }).skills;
      // `haveCombatSkills` needs ALL FOUR, so the minimum is the only one that matters.
      return Math.min(sk['strength'], sk['defense'], sk['dexterity'], sk['agility']) < gate.combat;
    })();

  /** Start faction work on the first accepted type; true if it stuck. */
  const workFaction = (faction: string, why: string): boolean => {
    for (const t of combatShort ? COMBAT_WORK_TYPES : WORK_TYPES) {
      if (s['workForFaction'](faction, t, true)) {
        ns.tprint(
          `=== repwork ${REV} — working faction ${faction} (${t}) — ${why}` +
            `${combatShort ? ` · combat XP toward the ${gate.faction} gate` : ''} ===`,
        );
        return true;
      }
    }
    return false;
  };

  // 1. THE RED PILL SHORTCUT — the highest-leverage rep in the run, so it outranks every megacorp.
  // Daedalus sells The Red Pill at 2.5M rep / $0, and that grind is the long pole of clearing a BitNode.
  // But the donation gate is only ~462.5k lifetime rep away: grind to THAT, let an install bank the favor,
  // and redpill.js buys the remaining 2.5M for cash. We stop the moment we hold enough rep to cross —
  // more favor than the gate buys nothing here, and install.js's favor trigger takes it from there.
  if (strat.rep.redPillFavorRoute && inFactions.has(DAEDALUS)) {
    const favor = s['getFactionFavor'](DAEDALUS);
    const rep = s['getFactionRep'](DAEDALUS);
    const short = repToReachFavor(favor, minFavor) - rep;
    if (favor < minFavor && short > 0) {
      const why = `${ns.format.number(short)} rep from the ${minFavor}-favor gate — then the Red Pill is cash`;
      if (workFaction(DAEDALUS, why)) return;
    }
  }

  // 2. Megacorp path — unlock, then collect its augs, per target in order.
  if (strat.rep.companyRepPhase) {
    const fields = [ns.enums.JobField.software, ns.enums.JobField.it, ns.enums.JobField.business];
    for (const company of strat.rep.companyTargets) {
      if (s['getAugmentationsFromFaction'](company).every((a) => owned.has(a))) continue; // nothing to gain here
      if (inFactions.has(company)) {
        // In the faction — grind ITS rep for its augs, UNLESS donations already cover it. This is the case
        // that prompted the whole feature: a company faction sitting on 150+ favor and a huge bank, being
        // ground by hand for rep that augs.js could have bought outright in the same cycle.
        if (repGatedLeft(company) && !donatable(company)) {
          if (workFaction(company, 'megacorp augs')) return;
        }
        continue; // augs done, rep already sufficient, or purchasable — next company
      }
      // Not in the faction yet — grind the company job to unlock it. Donations cannot buy an INVITE, so
      // this path is never skippable no matter how rich we are.
      let job: string | null = null;
      for (const field of fields) {
        job = s['applyToCompany'](company, field);
        if (job) break;
      }
      if (!job) {
        ns.tprint(`INFO  repwork: not qualified for a job at ${company} yet — stats too low.`);
        continue;
      }
      if (s['workForCompany'](company, true)) {
        ns.tprint(`=== repwork ${REV} — working ${company} (${job}) toward its faction invite ===`);
        return;
      }
    }
  }

  // 3. General faction rep. Skip the gang faction (passive rep) and anything already donatable.
  const ranked = [...inFactions]
    .filter((f) => f !== gangFaction && !donatable(f))
    .map((f) => {
      const rep = s['getFactionRep'](f);
      let want = 0;
      /** The priciest gated aug's shortfall — i.e. the rep that FINISHES this faction by hand, since
       * clearing the most expensive one clears every cheaper one along the way. */
      let augGap = 0;
      /** BEST VALUE-PER-REP available here — the number that decides where the slot goes.
       *
       * The slot buys reputation and nothing else, so the question is never "which faction has the most
       * augs" but "which rep is worth the most per point". Ranking by COUNT got that backwards and it
       * showed: in BN1 it picked OmniTek (many gated augs, 625k rep away, best `hacking x1.20`) over
       * BitRunners (fewer augs, `hacking x1.30`, 250k rep away) and would have ground hours for the
       * weaker outcome. See `lib/aug-value.ts` for why `hacking` dominates the weights. */
      let bestPerRep = 0;
      /** Total value of everything still gated here — what CROSSING THE FAVOR GATE unlocks, since past it
       * all of this faction's remaining rep becomes a cash purchase rather than slot time. */
      let gatedValue = 0;
      /** Every gated aug as (rep still needed, value), for the frontier below. Augs already affordable are
       * EXCLUDED: they need money, not slot time, and `augs.ts` is already buying them. Including them was
       * a real bug — `valuePerRep` returns Infinity at gap <= 0, so one affordable unbought aug made its
       * faction win the ranking outright, for reputation it did not need. */
      const gated: { gap: number; value: number }[] = [];
      for (const aug of s['getAugmentationsFromFaction'](f)) {
        if (owned.has(aug)) continue;
        const gap = s['getAugmentationRepReq'](aug) - rep;
        if (gap <= 0) continue;
        want++;
        if (gap > augGap) augGap = gap;
        const v = statsOk ? augValue(s['getAugmentationStats'](aug) as unknown as MultBag) : 0;
        gatedValue += v;
        gated.push({ gap, value: v });
      }

      // THE FRONTIER, and this is the part scoring a single best aug could not express: REPUTATION DOES
      // NOT TRANSFER BETWEEN FACTIONS. Grinding NiteSec to reach one aug and then still needing BitRunners
      // from 16.9k pays for both climbs, where BitRunners alone would have passed that aug's requirement
      // AND nine others on a single climb. Depth is worth real slot time, and per-aug ratios are blind to
      // it — which is how a two-aug faction outbid a ten-aug one on 2.44e-4.
      //
      // So: sort by rep needed, walk outward, and score each stopping point by the TOTAL value unlocked by
      // reaching it. The best of those is what this faction is worth. A deep faction beats a shallow one
      // whose single cheapest aug happens to be nearer, which is the correct answer when the shallow one
      // leaves you with the deep grind still ahead.
      gated.sort((a, b) => a.gap - b.gap);
      let cumulative = 0;
      for (const g of gated) {
        cumulative += g.value;
        const perRep = valuePerRep(cumulative, g.gap);
        if (perRep > bestPerRep) bestPerRep = perRep;
      }
      // Rep still needed ON TOP of what we hold for the next install to carry this faction over the
      // donation gate. 0 means the favor is already banked — installing now unlocks donations here, so
      // there is nothing further to gain by grinding it for FAVOR (its augs may still be worth rep).
      const gateGap = Math.max(0, repToReachFavor(s['getFactionFavor'](f), minFavor) - rep);

      // THE FAVOR GATE IS JUST ANOTHER PURCHASE, priced like any other. It costs `gateGap` reputation and
      // it buys `gatedValue` — everything still locked here, because past the gate that rep is money
      // rather than slot time (and money is the resource we are least short of).
      //
      // It used to be a separate PRIORITY TIER that outranked value outright, and that was wrong twice
      // over. Observed live in BN1: with no faction yet at 150 favor, EVERY candidate was in push mode,
      // so the tiebreak became "nearest to crossing" and the slot went to OmniTek — 4 augs left, best
      // `hacking x1.20` — while BitRunners sat with 10 augs including `hacking x1.30` only ~233k away.
      // Value was never consulted.
      //
      // The old guard (`augGap > gateGap`) was the second error: `augGap` is the PRICIEST gated aug, on
      // the reasoning that clearing the dearest clears the rest. That only holds if you want them all.
      // You want the valuable ones, which are routinely far cheaper — so it waved through pushes that a
      // direct grind beats comfortably.
      const gatePerRep = strat.rep.favorPush && gateGap > 0 ? valuePerRep(gatedValue, gateGap) : 0;
      // Push only when the gate genuinely outbids buying the best aug directly. Same units, same scale,
      // so it is a comparison rather than a policy.
      const favorShort = statsOk
        ? gatePerRep > bestPerRep
          ? gateGap
          : 0
        : strat.rep.favorPush && augGap > gateGap
          ? gateGap
          : 0;
      return { faction: f, want, favorShort, bestPerRep, gatePerRep };
    })
    .filter((c) => c.want > 0)
    .sort((a, b) => {
      // ONE ordering, by value per rep — whichever of "grind to the best aug" or "grind to the gate" is
      // the better buy at each faction. No tier jumps the queue any more.
      if (statsOk) {
        const aScore = Math.max(a.bestPerRep, a.gatePerRep);
        const bScore = Math.max(b.bestPerRep, b.gatePerRep);
        if (aScore !== bScore) return bScore - aScore;
      }
      // Pre-value fallback, used only when the 5 GB stats read could not be afforded: nearest-to-gate
      // first, then aug count. Worse, but it is the behaviour that shipped for weeks and it still moves.
      const aPush = a.favorShort > 0 ? 0 : 1;
      const bPush = b.favorShort > 0 ? 0 : 1;
      if (aPush !== bPush) return aPush - bPush;
      if (aPush === 0 && a.favorShort !== b.favorShort) return a.favorShort - b.favorShort;
      return b.want - a.want;
    });

  for (const c of ranked) {
    // Say WHICH buy won and at what price. A wrong pick should be diagnosable from one terminal line
    // rather than by re-deriving the ranking by hand — which is what the OmniTek episode actually cost.
    const why = !statsOk
      ? `${c.want} aug(s) gated — count fallback, no stats budget`
      : c.gatePerRep > c.bestPerRep
        ? `favor gate ${ns.format.number(c.favorShort)} rep away, unlocks ${c.want} aug(s) at ${c.gatePerRep.toExponential(2)}/rep`
        : `${c.want} gated aug(s), best frontier ${c.bestPerRep.toExponential(2)}/rep (gate would be ${c.gatePerRep.toExponential(2)})`;
    if (workFaction(c.faction, why)) return;
  }

  ns.tprint('INFO  repwork: nothing to work — company path done, and remaining faction rep is purchasable.');
}
