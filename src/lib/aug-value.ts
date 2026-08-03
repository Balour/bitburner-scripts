/**
 * What an augmentation is WORTH to a hacking run. Pure arithmetic over a `Multipliers` object — no NS
 * calls and no NS-named identifiers, so importing this costs 0 GB.
 *
 * ## Why this exists as shared code
 *
 * Three places rank augmentations and, until this file, all three ranked them differently — none by value:
 *
 *   - `augs.ts`     bought MOST-EXPENSIVE-FIRST. That is escalation management (put the 1.9^queued
 *                   multiplier on the cheap ones), not a judgement, so it was indifferent between QLink
 *                   and DermaForce except by price.
 *   - `repwork.ts`  ranked factions by COUNT of gated augs, ignoring what they were and how far the rep
 *                   was. Measured in BN1: it chose OmniTek (many augs, 625k rep) over BitRunners (fewer
 *                   augs, better ones, 250k rep) and would have ground for hours to reach a weaker result.
 *   - `probe/aug-priority.ts` had the only real scoring — and it was wired to nothing.
 *
 * One definition means the buyer, the rep grinder and the probe cannot disagree about what is worth
 * pursuing. Change a weight here and every consumer moves together.
 *
 * ## Why the weights look like this
 *
 * The endgame of every node is a hacking LEVEL requirement (`3000 * WorldDaemonDifficulty`), and level is
 * `mult * (32*ln(exp + 534.6) - 200)` — exponential in `level / mult`. Measured in BN1 on 2026-08-03:
 * hacking 1,259 at multiplier 3.241 on 97.36m XP. Reaching 3000 at that multiplier needs ~1.9e15 XP,
 * twenty million times what was held; reaching it at that XP needs a multiplier of ~7.7. So **experience
 * is almost never the binding constraint and the multiplier almost always is** — which is why `hacking`
 * outweighs `hacking_exp`, and why the money cluster barely registers.
 *
 * Reputation boosters lead everything because they COMPOUND: they do not buy one aug, they cheapen every
 * aug bought for the rest of the run, including the NeuroFlux ladder whose rep requirement climbs 1.14x
 * per level.
 */

/** A `Multipliers`-shaped bag. Kept as a plain record so this module never imports `@ns` at all and can
 * be read from a parsed file as easily as from `getAugmentationStats`. */
export type MultBag = Record<string, number>;

/**
 * Value of one augmentation for a hacking run. 0 means "buys nothing we care about" — true of combat,
 * crime, hacknet and bladeburner augs, and ALSO of the special-effect augs whose worth lives in game code
 * rather than in multipliers (CashRoot Starter Kit, Neuroreceptor Management Implant). Callers that care
 * about those must handle them separately; a score of 0 is not a verdict of worthless.
 */
/** What the run is actually pursuing. Scoring an aug without this is scoring it for a different game. */
export interface ValueContext {
  /** Is the megacorp path active (`strat.rep.companyRepPhase`)? When it is NOT, `company_rep` and
   * `charisma` are worth essentially nothing — there is no company being worked and no job to be hired
   * for — yet they are otherwise weighted like the best multipliers in the game.
   *
   * Observed in BN1 with the company path off: The Shadow's Simulacrum, a company-rep booster at 37.5k
   * rep, scored like a top pickup and pulled the action slot onto The Syndicate. The aug was priced for
   * a strategy that had been switched off hours earlier. */
  companyPath: boolean;
}

export function augValue(m: MultBag, ctx: ValueContext): number {
  const up = (k: string) => (m[k] ?? 1) - 1;
  // Rep boosters compound — they do not buy one aug, they cheapen every aug bought afterwards, including
  // the NeuroFlux ladder whose rep requirement climbs 1.14x per level. But only for reputation we are
  // ACTUALLY going to earn: with the company path off, company_rep compounds into nothing.
  const repValue = (up('faction_rep') + (ctx.companyPath ? up('company_rep') : 0)) * 3;
  return (
    repValue +
    // The binding constraint on the daemon climb, per the note above.
    up('hacking') * 2 +
    up('hacking_exp') * 1.5 +
    up('hacking_speed') * 1 +
    // Income, which is rarely what limits a mature run.
    (up('hacking_money') + up('hacking_grow') + up('hacking_chance')) * 0.3 +
    // Purely a gate-opener for getting hired. Worth nothing at all once that path is off.
    (ctx.companyPath ? up('charisma') * 0.5 : 0)
  );
}

/**
 * Value per unit of reputation still needed — the number that actually decides where the ACTION SLOT
 * goes, because the slot buys reputation and nothing else.
 *
 * A faction holding a `hacking x1.30` aug 250k rep away beats one holding `hacking x1.20` 625k rep away,
 * even though the second may list more augs in total. Ranking by count gets that backwards, which is
 * exactly what sent BN1's loop to OmniTek.
 *
 * `repGap <= 0` means it is already affordable and the slot is not what is missing — returns Infinity so
 * such augs sort first and the caller can buy rather than grind.
 */
export function valuePerRep(value: number, repGap: number): number {
  if (value <= 0) return 0;
  return repGap <= 0 ? Infinity : value / repGap;
}
