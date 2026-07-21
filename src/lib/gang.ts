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
/**
 * Take a trickle task — even Mug — while the next recruit costs less than this much respect.
 *
 * `respectForNextRecruit()` is `5^(members - 2)`, so the roster costs 5, 25, 125, 625, 3125, ... and
 * the first three are nearly free: at ~30 stats (about 2.5 min of Train Combat) three members make
 * ~0.04 respect/sec on Mug, which buys member 4 in ~2 min and member 6 inside half an hour. Every
 * member bought early then trains in PARALLEL, so the whole roster's ramp shifts left — this is
 * worth far more than the few minutes of training it costs.
 *
 * 200 stops it after member 6, deliberately. Past there the arithmetic inverts: member 7 (625) is
 * ~2h of mugging and member 8 (3,125) ~10h, while mugging builds stats 63x slower than training
 * (exp scales with difficulty^0.9 — Mug is difficulty 1, Train Combat is 100). Train instead, and
 * let Terrorism buy the rest: once it unlocks it pays ~69 respect/sec, clearing member 8 in a minute.
 *
 * Note a level-1 member cannot Mug at all — statWeight is `1 - 4*1 = -3`, so every task scores 0 and
 * they train regardless. This only ever engages once they can actually earn something.
 */
export const RECRUIT_RUSH_CEILING = 200;
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
/**
 * Turn clashes ON only when our win chance against EVERY live rival clears this...
 *
 * 0.5, not something safer, because clashing is the ONLY way to reduce a rival's power and the
 * asymmetry is ours: the loser's power is multiplied by 1/1.01, but the PLAYER's only by 1/1.008.
 * So at an even 50/50 our power ratio still improves ~0.14%/update while territory random-walks
 * with zero drift — over the ~350 updates it takes to reach 0.6, the expected territory change is 0
 * and the spread is sqrt(350) * 0.0001 ~ 0.19%, against a 14% holding. Negligible.
 *
 * Waiting for a higher floor is not "safe", it is expensive: our power rate is a fixed ~3.3/update
 * while a rival's is ~1.2, so each 0.05 of extra floor costs hours of blacked-out income, and floors
 * above ~0.6 are unreachable in peace at all (we cannot out-grow 9x their power without fighting).
 */
export const CLASH_ENGAGE_FLOOR = 0.5;
/** ...and back OFF below this. The gap is hysteresis, so we don't flap on the boundary. */
export const CLASH_DISENGAGE_FLOOR = 0.45;
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
 * $1m, not the $50m it was. $50m was picked against a mature save and is larger than a FRESH gang's
 * entire bank — it made equip.js a no-op for the one phase where cheap gear matters most, because
 * gear multiplies stats and stats are what a new roster has none of. It self-limits without a big
 * reserve: augs are funded first but cost billions, so at low cash they all fail this check and only
 * gear gets bought — a few tens of millions, once, and then the gang goes quiet on its own.
 *
 * Raise it (to a few billion) when you pivot to the hacking grind, or the gang will spend the cash
 * your personal-augment batches need. This is the one knob for the gang-vs-personal split.
 */
export const GANG_CASH_RESERVE = 1e6;

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
/**
 * ...but never let that fraction block gear this cheap, whatever the bank looks like.
 *
 * A pure fraction is self-defeating at the moment gear matters most: at a fresh gang's ~$5m, 5% is
 * $250k and the cheapest item is ~$925k after discount, so it buys NOTHING — while a member with no
 * gear is exactly the member a $1m bat helps most. The fraction is there to stop a pricey weapon
 * being churned by ascension; a floor at basic-kit prices costs nothing if it is churned, and the
 * fraction still governs everything above it once the bank is real.
 *
 * Worth more than it looks. Gear multiplies the STAT, and `calculateSkill(exp, mult)` puts exp
 * inside a log — so a mult of 1.5 reaches the Terrorism wall on ~22k exp where a bare member needs
 * ~144k. Cheap gear is not a rounding error early; it is ~6x off the training grind.
 */
export const GEAR_MIN_BUDGET = 2e6;
/**
 * Members parked on Territory Warfare while building power toward CLASH_ENGAGE_FLOOR.
 *
 * The WHOLE roster, and this is not a tuning preference — 4 was measured losing ground. Power is
 * `0.015 * territory * sum(memberPower)` and accrues ONLY from members on this task, while an NPC
 * gang gains ~1.2/update passively no matter what we do. With 4 members (and `warriors` slicing the
 * WEAKEST earners) we made 0.84/update against Speakers' 1.23 — the gap widened 4,100.35 -> 4,132.26
 * over ~27 minutes. Anything short of a decisive rate advantage is worse than not trying: it pays
 * the income cost and never arrives.
 *
 * Staffing is gated on POWER_BUILD_MAX_MS, so a roster too weak to win in reasonable time earns
 * instead of parking on a task it can never cash in.
 */
export const POWER_MEMBERS = MAX_MEMBERS;
/**
 * Win chance at which we consider ourselves DOMINANT.
 *
 * No longer used to stand the roster down — that was a mistake, measured: releasing here cost ~96%
 * of our power rate and would have roughly tripled the conquest. Staffing now holds until the rival
 * has no territory left (see gang.ts). This survives only as territory.js's "may we stay in a war we
 * are already winning" test, for the window after the roster stands down.
 */
export const POWER_RELEASE_FLOOR = 0.9;
/**
 * Give up on the whole territory project if reaching CLASH_ENGAGE_FLOOR would take longer than
 * this. Encodes the actual trade: a blackout is worth ~90x respect / ~170x money afterwards, but
 * only if it ends. This is what makes staffing self-enabling — a weak roster earns and buys augs,
 * augs raise stats, stats raise our power rate (updateSkillLevels folds equipment and ascension
 * mults into the stat BEFORE calculatePower reads it), and warfare switches itself on.
 *
 * 12h, not 24h, and the reasoning is NOT "24h is too long to wait" — it is that WAITING IMPROVES THE
 * ETA. Our rate scales with the roster while a rival's is capped at ~1.6/update, so an eta of 20h at
 * hour 8 may be an eta of 5h at hour 15 — firing early would black out for 20h and finish LATER than
 * waiting seven hours and blacking out for five. The gate should trigger when the eta is genuinely
 * short, not merely finite.
 *
 * UNVERIFIED. This is the one number in the file with no measurement behind it — a mature roster is
 * the only one we have ever observed, and it reports ~5h from any starting point. The shape of
 * eta(t) on a FRESH roster is exactly what a BN2 rerun would measure, and it is the most valuable
 * thing such a run would produce. Treat 12h as a guess with a rationale, not a result.
 */
export const POWER_BUILD_MAX_MS = 12 * 3600 * 1000;
/** GangConstants.CyclesPerTerritoryAndPowerUpdate (100) x CONSTANTS.MilliPerCycle (200). Power and
 * territory move on this clock, NOT the 2s gang clock. */
export const POWER_UPDATE_MS = 20_000;
/** Gang.calculatePower(): `0.015 * max(0.002, territory) * sum(memberPower)`. */
const POWER_GAIN_COEFF = 0.015;
/** src/Gang/data/power.ts. Drives an NPC gang's passive power growth; ours is not in play (the
 * player's gang gains only from members on the task). Speakers/Black Hand at 5 are the fast ones. */
export const POWER_MULTIPLIER: Record<string, number | undefined> = {
  'Slum Snakes': 1,
  Tetrads: 2,
  'The Syndicate': 2,
  'The Dark Army': 2,
  'Speakers for the Dead': 5,
  NiteSec: 2,
  'The Black Hand': 5,
};

/** GangMember.calculatePower(). The stats already include equipment/augmentation and ascension
 * multipliers — `updateSkillLevels()` applies them when deriving the stat from exp. */
export function memberPower(member: MemberInfo): number {
  return (member.hack + member.str + member.def + member.dex + member.agi + member.cha) / 95;
}

/** Our power gain per update if exactly `warriors` sit on Territory Warfare. */
export function ourPowerRate(info: GangInfo, warriors: MemberInfo[]): number {
  const total = warriors.reduce((sum, member) => sum + memberPower(member), 0);
  return POWER_GAIN_COEFF * Math.max(0.002, info.territory) * total;
}

/**
 * An NPC gang's EXPECTED power gain per update. The engine draws ONE roll and branches on it:
 *
 *   const gainRoll = Math.random();
 *   if (gainRoll < 0.5) power += Math.min(0.85, power * 0.005);          // hard-capped
 *   else                power += 0.75 * gainRoll * territory * powerMult;
 *
 * The subtlety is that `gainRoll` is reused as the additive coefficient, and that branch only runs
 * when `gainRoll >= 0.5` — so it is uniform on [0.5, 1) and its mean is **0.75, not 0.5**. Using 0.5
 * (as this did) understates the additive term by exactly 1.5x. The cap is why a large rival stops
 * accelerating: Speakers at 5,177 power would gain 25.9 from the multiplicative branch and takes
 * 0.85.
 */
export function npcPowerRate(faction: string, power: number, territory: number): number {
  const capped = Math.min(0.85, power * 0.005);
  const additive = 0.75 * 0.75 * territory * (POWER_MULTIPLIER[faction] ?? 2);
  return (capped + additive) / 2;
}

/**
 * Clashes per update that involve US. The engine loops over every gang holding territory (plus us)
 * and each picks ONE random opponent, skipping the roll only for pairs we're in. Two gangs left
 * (us + one rival) means literally 2. Seven gangs means we are `thisGang` once and get picked by one
 * of the other six with probability 1/6 each — also 2, in expectation. Stable either way.
 */
const CLASHES_PER_UPDATE = 2;
/** `calculateTerritoryGain`: `powerBonus * 0.0001 * (Math.random() + 0.5)`. The roll averages 1.0,
 * so this is the whole per-clash coefficient, as a fraction of the ENTIRE map (0.0001 = 0.01pp). */
const TERRITORY_GAIN_COEFF = 0.0001;

/** `Gang.clash(false)` does `power *= 1 / 1.008` — the fraction we shed per clash LOST. */
const POWER_LOSS_PER_CLASH = 1 - 1 / 1.008;
/** Staff this multiple of break-even onto warfare, so power drifts up rather than sitting on a knife
 * edge as the rival's power wobbles around its equilibrium. */
const POWER_HOLD_MARGIN = 2;

/**
 * Member-power needed on Territory Warfare to stop our power decaying — the size of the garrison.
 *
 * The useful identity: our decay is `(1 - win) * clashes * 0.00794 * ourPower`, and since
 * `1 - win = rivalPower / (ourPower + rivalPower)`, that whole product collapses to approximately
 * `rivalPower * 0.0159` once we're well ahead. It is **independent of our own power** — a small
 * constant set by whatever the rival has left. Against a rival pinned at ~56 power that is ~0.9 per
 * update, which a couple of weak members cover; there is no need to hold a crushed enemy down with
 * the whole roster.
 *
 * Divides by territory because our gain is `0.015 * territory * memberTotal` — so the garrison
 * SHRINKS as we conquer, freeing members to earn exactly as the war winds down.
 */
export function powerToHold(ourPower: number, rivalPower: number, territory: number): number {
  if (rivalPower <= 0 || ourPower <= 0) return 0;
  const win = ourPower / (ourPower + rivalPower);
  const decay = (1 - win) * CLASHES_PER_UPDATE * POWER_LOSS_PER_CLASH * ourPower;
  return (decay * POWER_HOLD_MARGIN) / (POWER_GAIN_COEFF * Math.max(0.002, territory));
}

/** `Math.max(1, 1 + Math.log(win.power / lose.power) / Math.log(50))`. Note the floor: a weaker
 * winner gets no penalty, only a stronger one gets a bonus — and it is logarithmic, so even a 50x
 * power lead only doubles the take. Territory is slow by design. */
function powerBonus(winPower: number, losePower: number): number {
  return Math.max(1, 1 + Math.log(winPower / losePower) / Math.log(50));
}

/**
 * Net share of the map we take from a rival per update, once clashing. Negative while we're losing.
 *
 * Verified against two live snapshots ~28 updates apart: predicted +0.406pp, observed +0.428pp.
 *
 * This is a CONSERVATIVE projection when used for an eta — it holds the current win chance and power
 * ratio fixed, but both improve as the rival's power collapses (they shed 1% per clash they lose
 * against a gain capped at 0.85). Expect to arrive early, not late.
 */
export function territoryRate(ourPower: number, rivalPower: number): number {
  if (rivalPower <= 0 || ourPower <= 0) return 0;
  const win = ourPower / (ourPower + rivalPower);
  const gain = win * powerBonus(ourPower, rivalPower);
  const loss = (1 - win) * powerBonus(rivalPower, ourPower);
  return CLASHES_PER_UPDATE * (gain - loss) * TERRITORY_GAIN_COEFF;
}

/**
 * Updates of warfare needed before `getChanceToWinClash` against this rival reaches `target`, given
 * both sides' power and growth. Infinity when our rate never outruns theirs — the case that makes
 * staffing warfare a pure loss. Win chance is exactly `ours / (ours + theirs)`, so the target is
 * `ours = k * theirs` with `k = target / (1 - target)`.
 */
export function updatesToChance(
  ourPower: number,
  ourRate: number,
  theirPower: number,
  theirRate: number,
  target: number,
): number {
  const k = target / (1 - target);
  const deficit = k * theirPower - ourPower;
  if (deficit <= 0) return 0;
  const closing = ourRate - k * theirRate;
  return closing > 0 ? deficit / closing : Infinity;
}

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
