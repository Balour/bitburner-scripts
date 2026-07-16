import type { NS } from '@ns';

/**
 * Gang constants + pure ranking math. No NS calls.
 *
 * RAM: importing the scoring functions costs **0.10 GB**, not 0. The static parser flattens
 * every identifier — including member-expression properties — against the whole NS cost table,
 * so reading `member.hack` collides with `ns.hack` (0.1 GB). `member.moneyGain` /
 * `.respectGain` / `.wantedPenalty` collide with the `ns.formulas.gang.*` entries, which are
 * 0 GB, so those are free. Importing only the constants costs nothing (named imports are
 * charged per symbol).
 */

export type GangInfo = ReturnType<NS['gang']['getGangInformation']>;
export type MemberInfo = ReturnType<NS['gang']['getMemberInformation']>;
export type TaskStats = ReturnType<NS['gang']['getTaskStats']>;
export type FactionArg = Parameters<NS['gang']['createGang']>[0];

/** Founding order. `createGang` returns false unless we're already a member of the faction, so
 * found.ts just walks this list — there is no non-Singularity way to query joined factions.
 *
 * Combat gangs only, deliberately. NiteSec / The Black Hand are the only two hacking gangs, and
 * hacking gangs are never preferred: every hacking task has a territory exponent of 1, while
 * combat tasks reach 1.5 (Human Trafficking money) and 2.0 (Terrorism respect). Since
 * `territoryMult = max(0.005, pow(territory*100, exp)/100)` and `territory*100 > 1` from the
 * start, a higher exponent wins at every territory level, not just late.
 *
 * The Syndicate leads because outside BN2 the founding faction's OWN augmentations are the only
 * ones guaranteed (`GangUniqueAugs` < 1 makes every other faction's exclusives a coin-flip), and
 * it has the deepest roster. In BN2 `GangUniqueAugs` is 1, so the catalog is faction-independent
 * and this collapses to "whichever we got into" — which is Slum Snakes. */
export const FOUNDER_PREFERENCE = [
  'The Syndicate',
  'Slum Snakes',
  'Tetrads',
  'The Dark Army',
  'Speakers for the Dead',
] as const;

export const MAX_MEMBERS = 12;
/** baseRespect that marks a "real" earning task worth doing over training. Above it: Terrorism
 * (0.01), Cyberterrorism (0.01), Human Trafficking (0.004), Money Laundering (0.001). Below it: the
 * low-tier trickle (Mug 0.00005, Strongarm, Armed Robbery, ...) that a member should train past
 * rather than settle on, since mugging's difficulty-1 builds stats ~63x slower than training. */
export const EARN_UNLOCK_RESPECT = 0.001;
/** Gang respect converts to faction rep at this divisor (GangConstants.GangRespectToReputationRatio). */
export const RESPECT_TO_REP = 75;

export const TASK_IDLE = 'Unassigned';
export const TASK_WARFARE = 'Territory Warfare';
export const TASK_VIGILANTE = 'Vigilante Justice';
/** All four of the above, plus these, are shared tasks — available to hacking AND combat gangs. */
export const TASK_TRAIN_COMBAT = 'Train Combat';
export const TASK_TRAIN_HACKING = 'Train Hacking';

/** Ascend when the best stat multiplier would grow by at least this factor. */
export const ASCEND_THRESHOLD = 1.15;
/** Turn clashes ON only when our win chance against EVERY live rival clears this... */
export const CLASH_ENGAGE_FLOOR = 0.6;
/** ...and back OFF below this. The gap is hysteresis, so we don't flap on the boundary. */
export const CLASH_DISENGAGE_FLOOR = 0.55;
/** wantedPenalty multiplies BOTH respect and money gain, so letting it sag is expensive. */
export const WANTED_PENALTY_FLOOR = 0.95;
/**
 * ...but do NOT act on that ratio until the wanted level has actually risen off its floor.
 *
 * The engine pins `wanted` to a minimum of 1 (`Gang.ts`: `if (this.wanted < 1) this.wanted = 1`),
 * and `wantedPenalty = respect / (respect + wanted)`. A new gang therefore starts at respect 0,
 * wanted 1 — penalty 0, i.e. permanently "below floor" before it has done anything at all.
 * Gating vigilante duty on the ratio alone DEADLOCKS: everyone gets sent to Vigilante Justice,
 * which earns no respect, so the ratio can never recover. Measured, the hard way.
 */
export const WANTED_LEVEL_FLOOR = 2;
/** And never put more than this share of earners on vigilante duty — it earns nothing, so a full
 * roster of it is a full stop. */
export const VIGILANTE_MAX_FRACTION = 0.5;

/**
 * Cash the gang keeps its hands off. It exists for a LATER phase: the way out of BN2 is YOUR
 * hacking level (15,000), bought up with personal hacking augs — which don't help the gang and,
 * with hacking-money nerfed this node, aren't worth buying until the gang is a fat money engine.
 * So while we're still building that engine, this is deliberately LOW: pour cash into the gang.
 *
 * Raise it (to a few billion) when you pivot to the hacking grind, or the gang will spend the cash
 * your personal-augment batches need. This is the one knob for the gang-vs-personal split.
 */
export const GANG_CASH_RESERVE = 5e7;

/**
 * Two tiers, because `ascend()` treats them differently — `this.upgrades.length = 0` destroys
 * equipment, then re-applies `this.augmentations`:
 *
 *   - **Augmentations survive ascension AND install.** They are the durable gang investment, so we
 *     buy them as aggressively as the reserve allows — this is what absorbs idle cash.
 *   - **Equipment is destroyed on every ascension.** Capped at this fraction of cash per item so a
 *     single pricey weapon can't get churned every ascension. At 5% this clears the Katana ($11m)
 *     once cash is ~$220m and unlocks the rest of the rack as the pile grows. (2% was too tight —
 *     it skipped the Katana even at $500m cash, landing just over a $10m cap.) Gear is cheap
 *     regardless — a fully kitted roster is only tens of millions; the billion-dollar augs are what
 *     absorb a large pile, and those wait until cash can reach them.
 */
export const GEAR_BUDGET_FRACTION = 0.05;
/** Members parked on Territory Warfare while building power toward CLASH_ENGAGE_FLOOR... */
export const POWER_MEMBERS = 4;
/** ...and kept there afterwards, since NPC gangs keep growing power passively. */
export const POWER_MAINTAIN = 2;

/** GangSoftcap by BitNode — the only BitNode-aware value in the whole gang system. It enters the
 * formulas ONLY as an exponent applied identically to every task, so it cannot reorder them and
 * the ranker below ignores it. Kept for the "is a gang worth running here" judgement: it is 0 in
 * BN8 (gang is dead), 0.3 in BN13, and 1 in BN4 — full rate in the node that guts everything else. */
export const GANG_SOFTCAP: Record<number, number> = {
  3: 0.9,
  6: 0.7,
  7: 0.7,
  8: 0,
  9: 0.8,
  10: 0.9,
  12: 0.8,
  13: 0.3,
  14: 0.7,
};

/* --------------------------------------------------------------------------------------------
 * Transcribed verbatim from src/Gang/formulas/formulas.ts. The difficulty penalty differs per
 * formula (respect 4x, wanted 3.5x, money 3.2x) — do not "simplify" that.
 * ------------------------------------------------------------------------------------------ */

function statWeight(member: MemberInfo, task: TaskStats, difficultyPenalty: number): number {
  const weighted =
    (task.hackWeight / 100) * member.hack +
    (task.strWeight / 100) * member.str +
    (task.defWeight / 100) * member.def +
    (task.dexWeight / 100) * member.dex +
    (task.agiWeight / 100) * member.agi +
    (task.chaWeight / 100) * member.cha;
  return weighted - difficultyPenalty * task.difficulty;
}

function territoryMult(info: GangInfo, exponent: number): number {
  const mult = Math.max(0.005, Math.pow(info.territory * 100, exponent) / 100);
  return Number.isFinite(mult) && mult > 0 ? mult : 0;
}

/** respect / (respect + wantedLevel). Scales both respect AND money gain. */
export function penaltyOf(info: GangInfo): number {
  return info.respect / (info.respect + info.wantedLevel);
}

/**
 * Ranking score, NOT a real rate: the game raises the value below to the power of
 * `(0.2 * territory + 0.8) * GangSoftcap`. That exponent is identical for every task, and
 * x -> x^k is monotone for k > 0, so dropping it cannot change which task wins. It also makes
 * the ranker BitNode-independent for free. Real rates come from GangGenInfo's *GainRate fields,
 * or from ns.formulas.gang.* when Formulas.exe is owned.
 */
export function respectScore(info: GangInfo, member: MemberInfo, task: TaskStats): number {
  if (task.baseRespect === 0) return 0;
  const weight = statWeight(member, task, 4);
  if (weight <= 0) return 0;
  const mult = territoryMult(info, task.territory.respect);
  if (mult === 0) return 0;
  return 11 * task.baseRespect * weight * mult * penaltyOf(info);
}

/** Same monotone-exponent caveat as respectScore. */
export function moneyScore(info: GangInfo, member: MemberInfo, task: TaskStats): number {
  if (task.baseMoney === 0) return 0;
  const weight = statWeight(member, task, 3.2);
  if (weight <= 0) return 0;
  const mult = territoryMult(info, task.territory.money);
  if (mult === 0) return 0;
  return 5 * task.baseMoney * weight * mult * penaltyOf(info);
}

/** This one is EXACT — the wanted formula carries no softcap exponent — so the wanted-control
 * loop is correct even without Formulas.exe. Negative for Vigilante Justice / Ethical Hacking. */
export function wantedGain(info: GangInfo, member: MemberInfo, task: TaskStats): number {
  if (task.baseWanted === 0) return 0;
  const weight = statWeight(member, task, 3.5);
  if (weight <= 0) return 0;
  const mult = territoryMult(info, task.territory.wanted);
  if (mult === 0) return 0;
  if (task.baseWanted < 0) return 0.4 * task.baseWanted * weight * mult;
  return Math.min(100, (7 * task.baseWanted) / Math.pow(3 * weight * mult, 0.8));
}
