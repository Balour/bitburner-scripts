/**
 * Skill level <-> experience. Pure math — no NS calls and no NS-named identifiers — so importing this
 * costs 0 GB. Mirrors `src/PersonObjects/formulas/skill.ts` in bitburner-src.
 *
 * Why it matters for the endgame: experience is EXPONENTIAL in `level / mult`, so the cost of the last
 * stretch of a climb is brutal and the payoff from a multiplier is enormous. Concretely, going from level
 * A to level B costs `e^((B-A)/(32*mult))` times your current total XP — at mult 8, the last 1,300 levels
 * of a 9,000 climb need ~170x every point of XP the run has ever earned. Raising the mult from 8 to 14
 * cuts the XP needed for 9,000 by about six orders of magnitude.
 *
 * That asymmetry is the whole argument for `endgame.pushAbandonMs`: when a climb projects long, installing
 * to bank multipliers and re-climbing from 1 is almost always faster than finishing the climb you are on.
 *
 * `ns.formulas.skills.calculateExp` is the same function, but costs a $5b Formulas.exe we may not own.
 */

/** Experience needed to reach `level` at a given stat multiplier. Inverse of the game's `calculateSkill`
 * (`floor(mult * (32 * ln(exp + 534.6) - 200))`). Returns 0 for a non-positive multiplier — in BN12 a high
 * SF-12 level can drive a mult to 0, where the skill never moves and no amount of XP helps. */
export function expForSkill(level: number, mult = 1): number {
  if (mult <= 0) return 0;
  return Math.max(0, Math.exp((level / mult + 200) / 32) - 534.6);
}

/** Skill level from experience — the game's own formula, floor included, clamped to a minimum of 1. */
export function skillFromExp(exp: number, mult = 1): number {
  if (mult <= 0) return 1;
  return Math.max(1, Math.floor(mult * (32 * Math.log(exp + 534.6) - 200)));
}
