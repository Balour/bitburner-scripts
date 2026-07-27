/**
 * Faction favor <-> reputation. Pure math — no NS calls and no NS-named identifiers — so importing this
 * costs 0 GB. Mirrors `src/Faction/formulas/favor.ts` in bitburner-src exactly.
 *
 * Why we need it: favor is the gate on `donateToFaction`, and favor is only ever awarded at an INSTALL,
 * which converts a faction's reputation into favor and resets rep to 0 (`Faction.prestigeAugmentation`).
 * So "how much longer do I grind this faction before donations unlock there?" is a rep question with a
 * favor answer, and this converts between the two.
 *
 * `ns.formulas.reputation.calculateFavorToRep` does the same thing, but costs a $5b Formulas.exe we may
 * not own. The formula is closed-form and stable, so we just carry it.
 */

/** The nearest representable value of log(1.02), the base of the favor series. The game uses this exact
 * literal and NOT `Math.log(1.02)` — "1.02" lacks the precision — so copying it keeps our numbers
 * bit-identical to the game's instead of drifting a fraction of a favor point. */
const LOG_1P02 = 0.019802627296179712;

/** Total lifetime reputation represented by `favor` points. The series is sum(0..f) of 500*1.02^f, in
 * closed form. Landmark: `favorToRep(150)` ~= 462,500 — the rep a faction must bank across its installs
 * before donations unlock at the standard 150-favor gate. */
export function favorToRep(favor: number): number {
  // expm1 is e^x - 1, more accurate for small x than the obvious way.
  return Math.max(0, 25000 * Math.expm1(LOG_1P02 * favor));
}

/**
 * Reputation that must be HELD AT THE MOMENT OF AN INSTALL to carry a faction from `favor` to
 * `targetFavor`. Not a running total across installs: favor already banked is subtracted, so re-reading
 * live favor after each install always gives the remaining shortfall.
 */
export function repToReachFavor(favor: number, targetFavor: number): number {
  return Math.max(0, favorToRep(targetFavor) - favorToRep(favor));
}
