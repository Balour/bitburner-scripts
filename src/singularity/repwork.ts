import type { NS } from '@ns';
import { strategyFor } from '../lib/strategy';
import { sing, reserveOk } from './api';

/**
 * P2 action-slot work (Singularity), one-shot. Priority:
 *   1. MEGACORP PATH — walk `companyTargets` in order and process each FULLY before the next: if we're not
 *      in its faction, grind the company job to unlock it; once in, grind its FACTION rep for its own augs
 *      (e.g. Bachman -> SmartJaw). Unlocking a megacorp is only worth it for its augs, so collect them
 *      before moving on. A target whose augs we already own (rep-boosters are sold by many factions) is
 *      skipped entirely.
 *   2. FACTION rep — the remaining joined factions (BitRunners, CyberSec, ...) with unowned rep-gated augs,
 *      best-first, skipping the gang faction (its rep accrues passively). Only reached once the megacorp
 *      path is exhausted, so trim `companyTargets` if you'd rather finish a faction's augs sooner.
 * Prefers hacking work (also grows hacking XP). Work persists after this exits; the controller re-runs it.
 *
 * Run: `run /singularity/repwork.js`
 */
const REV = 'v5';
const WORK_TYPES = ['hacking', 'security', 'field'];

export async function main(ns: NS) {
  if (!reserveOk(ns, 40, 28)) return;
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);
  const owned = new Set(s['getOwnedAugmentations'](true));
  const inFactions = new Set<string>(ns.getPlayer().factions);

  /** Does `faction` have an unowned aug we still lack the rep to buy? */
  const repGatedLeft = (faction: string): boolean => {
    const rep = s['getFactionRep'](faction);
    return s['getAugmentationsFromFaction'](faction).some((a) => !owned.has(a) && s['getAugmentationRepReq'](a) > rep);
  };
  /** Start faction work on the first accepted type; true if it stuck. */
  const workFaction = (faction: string): boolean => {
    for (const t of WORK_TYPES) {
      if (s['workForFaction'](faction, t, true)) {
        ns.tprint(`=== repwork ${REV} — working faction ${faction} (${t}) toward its augs ===`);
        return true;
      }
    }
    return false;
  };

  // 1. Megacorp path — unlock, then collect its augs, per target in order.
  if (strat.rep.companyRepPhase) {
    const fields = [ns.enums.JobField.software, ns.enums.JobField.it, ns.enums.JobField.business];
    for (const company of strat.rep.companyTargets) {
      if (s['getAugmentationsFromFaction'](company).every((a) => owned.has(a))) continue; // nothing to gain here
      if (inFactions.has(company)) {
        // In the faction — grind ITS rep for its augs (SmartJaw etc.) before touching the next company.
        if (repGatedLeft(company)) {
          if (workFaction(company)) return;
        }
        continue; // augs done or rep already sufficient (augs.js will buy) — next company
      }
      // Not in the faction yet — grind the company job to unlock it.
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

  // 2. General faction rep — remaining joined factions, most rep-gated augs first. Skip the gang faction.
  const gangFaction = ns.gang.inGang() ? ns.gang.getGangInformation().faction : '';
  const ranked = [...inFactions]
    .filter((f) => f !== gangFaction)
    .map((f) => {
      const rep = s['getFactionRep'](f);
      let want = 0;
      for (const aug of s['getAugmentationsFromFaction'](f)) {
        if (!owned.has(aug) && s['getAugmentationRepReq'](aug) > rep) want++;
      }
      return { faction: f, want };
    })
    .filter((c) => c.want > 0)
    .sort((a, b) => b.want - a.want);

  for (const { faction } of ranked) {
    if (workFaction(faction)) return;
  }

  ns.tprint('INFO  repwork: nothing to work — company path done and faction augs drained.');
}
