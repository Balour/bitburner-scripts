import type { NS } from '@ns';
import { strategyFor } from '../lib/strategy';
import { sing, reserve } from './api';

/**
 * P2 action-slot work (Singularity), one-shot. Two-tier:
 *   1. FACTION rep — work the joined faction with the most unowned rep-gated augs (best rep investment),
 *      skipping the gang faction (the game blocks working your own gang; that rep comes passively) and
 *      falling through if one refuses every work type.
 *   2. When faction rep is exhausted → COMPANY rep — grind a megacorp job (Four Sigma first) toward its
 *      same-named faction's invite, which then re-enters tier 1 with a fresh batch of hacking augs.
 * Prefers hacking work (also grows hacking XP toward the endgame). Work persists after this exits; the
 * controller re-runs it to re-target.
 *
 * Run: `run /singularity/repwork.js`
 */
const REV = 'v3';
const WORK_TYPES = ['hacking', 'security', 'field'];

export async function main(ns: NS) {
  reserve(ns, 40);
  const s = sing(ns);
  const strat = strategyFor(ns.getResetInfo().currentNode);
  const owned = new Set(s['getOwnedAugmentations'](true));
  const inFactions = new Set<string>(ns.getPlayer().factions);
  // The gang's own faction can't be worked (rep accrues through the gang) — exclude it.
  const gangFaction = ns.gang.inGang() ? ns.gang.getGangInformation().faction : '';

  // Tier 1: rank workable factions by rep-gated augs remaining, try best-first.
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

  for (const { faction, want } of ranked) {
    for (const t of WORK_TYPES) {
      if (s['workForFaction'](faction, t, true)) {
        ns.tprint(`=== repwork ${REV} — working faction ${faction} (${t}) toward ${want} aug(s) ===`);
        return;
      }
    }
  }

  // Tier 2: company rep toward a megacorp faction unlock (skip ones whose faction we already joined).
  // Try to get hired on the hacking track first, then IT/Business; only work if a position was granted —
  // applyToCompany returns null when our stats are too low (common right after an aug-reset), and calling
  // workForCompany without a job throws. So this quietly waits until stats recover rather than erroring.
  if (strat.rep.companyRepPhase) {
    const fields = [ns.enums.JobField.software, ns.enums.JobField.it, ns.enums.JobField.business];
    for (const company of strat.rep.companyTargets) {
      if (inFactions.has(company)) continue;
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

  ns.tprint('INFO  repwork: nothing to work — faction augs drained and no company target available.');
}
