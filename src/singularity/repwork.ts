import type { NS } from '@ns';
import { liveStrategy } from '../lib/bitnode';
import { repToReachFavor } from '../lib/favor';
import { sing, reserveOk } from './api';

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
 * - **Push factions over the favor gate first** (`strat.rep.favorPush`) — but ONLY where the gate is the
 *   cheaper route. Favor is awarded only at an install, which converts rep to favor and zeroes the rep.
 *   Crossing turns that faction's rep from a time cost into a money cost PERMANENTLY (for the rest of the
 *   BitNode — favor resets on entering a new one), so the last stretch before the gate outranks a faction
 *   that merely has more augs on offer. The qualifier matters: if the priciest gated aug is closer than
 *   the gate, grinding the augs directly is both cheaper AND finishes the faction, and pushing for favor
 *   is pure waste. Compare the two gaps; never assume the gate wins.
 *
 * Run: `run /singularity/repwork.js`
 */
const REV = 'v9';
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
      for (const aug of s['getAugmentationsFromFaction'](f)) {
        if (owned.has(aug)) continue;
        const gap = s['getAugmentationRepReq'](aug) - rep;
        if (gap > 0) {
          want++;
          if (gap > augGap) augGap = gap;
        }
      }
      // Rep still needed ON TOP of what we hold for the next install to carry this faction over the
      // donation gate. 0 means the favor is already banked — installing now unlocks donations here, so
      // there is nothing further to gain by grinding it for FAVOR (its augs may still be worth rep).
      const gateGap = Math.max(0, repToReachFavor(s['getFactionFavor'](f), minFavor) - rep);
      // ...and only PUSH for it where the gate is genuinely the cheaper route. Crossing costs `gateGap`
      // rep and then money; finishing by hand costs `augGap` rep and nothing else. When augGap is the
      // smaller number the push is strictly wasted work — it buys donation access to a faction we are
      // about to have no further use for, since buying the augs empties it and `want` drops to 0.
      //
      // Observed in BN5: CyberSec, priciest gated aug 18.75k rep, being ground 332.768k rep toward the
      // gate — 17x the work for zero gain. Daedalus is the shape this feature IS for (2.5M rep for The
      // Red Pill against ~462.5k to cross) and still qualifies, as does any megacorp with a deep catalogue.
      const favorShort = strat.rep.favorPush && augGap > gateGap ? gateGap : 0;
      return { faction: f, want, favorShort };
    })
    .filter((c) => c.want > 0)
    .sort((a, b) => {
      // Factions still short of the gate come first, nearest-to-crossing leading: that rep buys permanent
      // donation access, which is worth more than any single aug behind it. Then by aug count.
      const aPush = a.favorShort > 0 ? 0 : 1;
      const bPush = b.favorShort > 0 ? 0 : 1;
      if (aPush !== bPush) return aPush - bPush;
      if (aPush === 0 && a.favorShort !== b.favorShort) return a.favorShort - b.favorShort;
      return b.want - a.want;
    });

  for (const c of ranked) {
    const why =
      c.favorShort > 0
        ? `${ns.format.number(c.favorShort)} rep from the ${minFavor}-favor donation gate · ${c.want} aug(s) gated`
        : `${c.want} aug(s) gated`;
    if (workFaction(c.faction, why)) return;
  }

  ns.tprint('INFO  repwork: nothing to work — company path done, and remaining faction rep is purchasable.');
}
