/**
 * Per-BitNode strategy config. Types + constant data + one PURE merge function —
 * no NS calls, no NS-named identifiers, so importing this costs 0 GB. Keep it that way.
 *
 * This is the "customizable" layer the automation loop rides: a single DEFAULT strategy
 * plus per-node OVERRIDES, merged by `strategyFor(node)`. bootstrap and the Singularity
 * controller read it so node-specific behaviour lives in ONE place, not scattered across
 * scripts. It absorbs `ports.BN_DISABLE` (the older subsystem opt-out table) by wrapping
 * it: `disabledSubsystems` is computed from BN_DISABLE so there is still one source of truth
 * for which stack entries a node skips.
 *
 * Every future run passes through this. When a node needs a different plan, add an entry to
 * OVERRIDES — do not fork the controllers.
 */
import type { BitNodeMultipliers } from '@ns';
import { BN_DISABLE } from './ports';

/**
 * The BitNode multipliers this module consumes, injected by the caller (see `liveStrategy` in
 * `lib/bitnode.ts`). Deliberately narrow: every field has a decision attached, so adding one should mean
 * adding the logic that reads it. `Pick` keeps us honest against the real `BitNodeMultipliers` — a field
 * renamed in a game update becomes a compile error rather than a silent 1.0.
 *
 * EVERY FIELD IS OPTIONAL, and that is load-bearing rather than laziness. The record lives in a file that
 * survives augment installs, so a record written by an older `probe/bitnode.js` legitimately lacks fields
 * added later — exactly the cross-version port hazard `lib/ports.ts` warns about. Rejecting the whole
 * record over one missing field would throw away the fields that ARE there, so each is guarded at its
 * point of use and falls back to the neutral 1.0 instead.
 *
 * It is declared HERE, in the consumer, and not in `lib/bitnode.ts`, on purpose. bitnode imports
 * `strategyFor` as a VALUE; if strategy imported this type back from bitnode the two modules would form
 * an import cycle that survives only as long as the transform erases the type import exactly as expected.
 * Declaring it here makes the dependency strictly one-way — `bitnode -> strategy -> ports` — so there is
 * no cycle to reason about. `@ns` is types only, so this import is free and erases completely.
 */
export type BitNodeMults = Partial<
  Pick<
    BitNodeMultipliers,
    | 'WorldDaemonDifficulty'
    | 'CloudServerLimit'
    | 'ScriptHackMoney'
    | 'ServerMaxMoney'
    | 'GangSoftcap'
    | 'DaedalusAugsRequirement'
  >
>;

/**
 * Which economy the player ACTION SLOT bootstraps.
 *
 * This is the only genuinely contended resource in the run. The daemon, coding contracts, aug buying,
 * installs and home upgrades are all already parallel and do not care which route is active — so this
 * is not "two pipelines", it is one scheduler with one output.
 *
 * - `hacking` — the slot goes to faction rep from tick zero. Correct wherever the daemon is not
 *   throttled: the gang's ~10-17h karma cold start buys an income stream we already have.
 * - `gang` — the slot goes to the homicide karma grind until the gang exists, then to rep. Correct
 *   where hacking income is crippled (BN2 at 8% max money, BN4 at 20%, BN5 at 15%) and the gang is
 *   genuinely the only economy.
 *
 * Bladeburner will be a third value once SF-6/7 exist. That is the reason this is an enum and not a
 * boolean, and the reason `crime.needGang` is derived from it rather than set alongside it.
 */
export type Route = 'hacking' | 'gang';

/**
 * The city-faction blocs, as ONE choice with four outcomes. Verified in `Faction/FactionInfo.tsx`:
 * Sector-12 and Aevum each omit the other from `enemies`; Chongqing / New Tokyo / Ishima are mutually
 * compatible; Volhaven is an enemy of all five. Joining any member forecloses the other blocs PERMANENTLY
 * for the BitNode.
 *
 * Modelled as a keyed table rather than a free `string[]` on purpose: a list would let a caller configure
 * `['Sector-12', 'Chongqing']` and lock itself out of both, and nothing would catch it until the invite
 * silently never arrived. This shape cannot express that.
 *
 * Measured in BN1 with `/probe/aug-priority.js` (marginal augs — ones no cheaper faction already sells):
 *   eastern   3 augs, best Neuregen Gene Modification (score 0.60, overall #17)
 *   western   2 augs, best PCMatrix (0.51, #19), plus CashRoot Starter Kit
 *   volhaven  1 aug,  DermaForce Particle Barrier (0.03, #50) — not worth a thought
 * The scores are all marginal; what actually decides it is that eastern's cities are also where Tian Di
 * Hui's invite lives, so one trip collects both.
 */
export const CITY_BLOCS: Record<CityBloc, string[]> = {
  none: [],
  eastern: ['Chongqing', 'New Tokyo', 'Ishima'],
  western: ['Sector-12', 'Aevum'],
  volhaven: ['Volhaven'],
};
export type CityBloc = 'none' | 'eastern' | 'western' | 'volhaven';

export interface RouteStrategy {
  /** The action-slot economy. Derived from live multipliers when they are available (see
   * `strategyFor`), overridable per node. */
  primary: Route;
  /** Found a gang if karma reaches the gate ANYWAY — crime-money bridging accumulates it as a side
   * effect, and sleeves will later. Never spends slot time chasing it, so this is free upside; the
   * gang is income plus a faction that accrues rep passively. Only meaningful on the hacking route,
   * where nothing is deliberately grinding karma. */
  gangIfFree: boolean;
}

/** Cold-start crime -> gang path. Only used while `route.primary === 'gang'`. */
export interface CrimeStrategy {
  /** DERIVED from `route.primary` — never set this in OVERRIDES, set `route` instead. Kept as a field
   * because the controller and crime.ts read it, and because "is the karma grind active" is a
   * different question from "which route are we on" once Bladeburner exists. */
  needGang: boolean;
  /** Karma to found a gang. NEGATIVE. -54000 everywhere except BN2 (which bypasses the gate). */
  karmaTarget: number;
  /** Switch gym -> homicide grind once `getCrimeChance('Homicide')` reaches this (0..1). Below it,
   * training STR/DEF at the gym buys more karma/sec than low-odds homicides do. */
  homicideChanceSwitch: number;
  /** Train STR and DEF (homicide's weight-2 stats) toward roughly this level before leaning on
   * homicide. A ceiling, not a gate — `homicideChanceSwitch` is the real trigger; this caps gym time
   * so we do not over-train when the node's exp multipliers make the last levels slow. */
  gymStatTarget: number;
}

/** Augment purchase budget.
 *
 * `focus` USED TO LIVE HERE and was removed: it was declared, set in three OVERRIDES entries, and read
 * by nothing for the whole life of the file. The behaviour it described — combat augs during the karma
 * grind, hacking augs after — is real and now implemented in `augs.ts`, derived from live phase
 * (`route.primary === 'gang' && !inGang`) rather than configured per node, because `strategyFor` cannot
 * know whether the gang exists yet. Don't reintroduce it as a knob. */
export interface AugStrategy {
  /** Keep at least this much liquid; never spend the reserve on augs. */
  cashReserve: number;
  /** After the priced one-time augs, dump surplus into NeuroFlux Governor levels. */
  neuroFluxDump: boolean;
}

/**
 * A late-game faction worth deliberately unlocking for one specific augmentation, gated behind COMBAT stats
 * the hacking loop never trains. Illuminati (QLink) is the case this exists for.
 *
 * Why it needs handling at all: `Player.prestigeAugmentation` sets `this.factions = []`, and zeroes both the
 * skills AND `exp.strength`/`defense`/`dexterity`/`agility`. So faction MEMBERSHIP and combat progress are
 * wiped by every install; only aug multipliers and faction FAVOR persist. Qualifying is not a one-time
 * achievement — it is re-earned each cycle, and a hacking loop has no other reason to touch combat.
 *
 * HOW IT IS SATISFIED: NOT the gym. Gym buys stats with pure action-slot time and pays no reputation, which
 * is a bad trade for anything past the early game. Instead `repwork.ts` takes the faction work it was going
 * to do anyway and picks a work type that also pays combat XP (field/security instead of hacking). The rep
 * still lands; only the flavour of XP alongside it changes.
 *
 * That works because the skill curve is exponential in `level / mult` (see `lib/skills.ts`). Starting from
 * zero exp, a cycle opens at `floor(mult * 0.99)` — so multipliers alone never reach the gate — but the exp
 * needed to close it collapses as multipliers stack: ~2.8k exp at combat mult 20 versus ~937k at mult 5.
 * The lever is therefore BUYING COMBAT AUGMENTATIONS, which the aug buyer already does whenever they are
 * affordable; the work-type switch just supplies the small amount of XP that multipliers cannot conjure.
 *
 * The non-combat thresholds decide TIMING, and are not redundant with the game's own check: combat progress
 * expires at the next install, so steering work before the other requirements are met spends the slot on
 * levels that are gone before an invite can arrive.
 */
export interface CombatGate {
  /** Faction to unlock. Empty string disables the whole step. */
  faction: string;
  /** Every combat skill must reach this — `haveCombatSkills(n)` requires all of str/def/dex/agi, so the
   * minimum of the four is the only one that matters. */
  combat: number;
  /** Don't steer work until hacking, cash and installed augs already clear the faction's other gates. */
  hacking: number;
  money: number;
  augs: number;
}

/** How reputation is earned to hit aug rep requirements. The controller compares candidates by
 * unlocked-aug-value per action-slot-second each cycle; these are the knobs that gate the choice. */
export interface RepStrategy {
  /** Buy faction rep with money (`donateToFaction`) instead of grinding it on the action slot, once
   * favor allows. The favor gate is deliberately NOT configured here: `ns.getFavorToDonate()` (0.1 GB,
   * base NS, not Singularity-taxed) reports the live per-BitNode threshold. It is
   * `150 * BitNodeMultipliers.FavorToDonateToFaction` — 150 in BN4, but 75 in BN3 and 0 in BN8, so a
   * hardcoded constant here would simply be wrong. */
  donate: boolean;
  /** Ceiling on one donation pass: this fraction of cash ABOVE `augs.cashReserve`.
   *
   * This single number IS the joint budget mechanism. Donated rep and aug prices are paid out of the
   * same wallet, and donated rep is a PER-CYCLE CONSUMABLE — installing augs resets faction rep to 0
   * (`Faction.prestigeAugmentation` converts it to favor), so rep bought and not spent before the next
   * install is money burned. Capping donations at a fraction of surplus guarantees the remainder is
   * still there to actually buy the augs the rep just unlocked. Raise toward 1.0 only if cash is
   * genuinely idle. */
  donateBudgetFraction: number;
  /** After every priced aug's rep gap is closed, also buy NeuroFlux Governor rep by donation. NFG is
   * an infinite ladder (rep req and price both climb ~1.14x per level), so nothing bounds this except
   * `donateBudgetFraction` — that cap is the only thing stopping it from eating the run's entire cash
   * pile every cycle. Worth it when the economy has outrun anything else to spend on. */
  donateNeuroFlux: boolean;
  /** Aim the action slot at factions that are CLOSE to the donation favor gate, ahead of factions that
   * merely have augs we want.
   *
   * Favor is only ever awarded at an install, which converts a faction's rep into favor and zeroes the rep
   * (`Faction.prestigeAugmentation`). Crossing the gate — ~462.5k lifetime rep at the standard 150 favor,
   * see `lib/favor.ts` — permanently converts that faction's rep from a TIME cost into a MONEY cost. So
   * the last stretch of rep before the gate is the highest-leverage work in the run, and it is worth
   * grinding ahead of a faction whose augs are nominally more numerous. Off = rank purely by aug count,
   * the pre-donation behaviour.
   *
   * NOT unconditional, and this is the part that is easy to get wrong: `repwork.ts` only pushes a faction
   * whose priciest GATED aug is further away than the gate itself. Where the augs are nearer, grinding
   * them directly is cheaper and also EMPTIES the faction, so donation access there would buy nothing.
   * Daedalus (2.5M rep for The Red Pill vs ~462.5k to cross) is the case worth pushing; a small faction
   * like CyberSec, whose whole remaining catalogue sits at ~18.75k rep, is not. */
  favorPush: boolean;
  /** THE RED PILL SHORTCUT. Once we are in Daedalus, put the action slot on it until its favor clears the
   * donation gate, ahead of every megacorp.
   *
   * The Red Pill costs 2.5M rep and $0, and it is the long pole of clearing a BitNode. Grinding 2.5M rep
   * by hand is hours. But the donation gate sits at only ~462.5k lifetime rep — so grinding to THAT,
   * letting an install bank the favor, and then buying the remaining 2.5M for cash is far cheaper in
   * wall-clock. (At faction_rep x2 in BN4 the donation is ~$1.67t: nothing to a mature gang run.)
   *
   * The catch, and why this is build-mode-only: the favor-banking install also resets hacking to 1, and
   * close mode exists precisely to stop installing so the climb to the daemon requirement can finish. Do
   * this BEFORE the endgame push or pay for it with an extra full re-climb. */
  redPillFavorRoute: boolean;
  /** Combat-gated faction to unlock deliberately. Runs AHEAD of the megacorp path and the Red Pill route,
   * but only once its non-combat thresholds are met — see `CombatGate`. */
  combatGate: CombatGate;
  /** Allow the LATE company-rep path: `applyToCompany` -> `workForCompany` to a megacorp faction's
   * invite threshold -> join -> work its rep. Needs high stats to get hired, so it is gated off early
   * and turned on once the economy is mature. */
  companyRepPhase: boolean;
  /** Companies to grind (job → its faction unlock) when faction rep-work is exhausted, in priority. Each
   * is both a company and a faction of the same name. Four Sigma first — its augs boost faction rep. */
  companyTargets: string[];
  /** Which mutually-exclusive city bloc `cities.js` may join. See `CITY_BLOCS`; 'none' skips cities
   * entirely, which is the conservative default because joining is irreversible for the BitNode.
   *
   * Tian Di Hui is NOT gated on this — it has no enemies, so `cities.js` always pursues it. This only
   * decides whether we additionally take the cities themselves, and which set. */
  cityBloc: CityBloc;
}

/**
 * Port openers / darkweb programs. One idea: below `richCash` money is scarce and the buyer is frugal — it
 * defers an opener until our hacking level reaches the lowest host that opener unlocks, so a poor run never
 * sinks $250m into SQLInject it cannot use yet. Above it money is not the constraint, and both brakes are
 * simply wrong.
 *
 * Skipping the LEVEL gate is the bigger half. `nuke` checks port requirements ONLY, never hacking level — so
 * owning SQLInject at hacking 1 immediately roots all 29 five-port servers for their RAM. An install wipes
 * every program and purchased server while the GANG earns straight through it, so re-buying the openers the
 * moment cash recovers is what ends the post-install RAM drought.
 */
export interface ProgramStrategy {
  /** Cash above which the buyer stops being frugal: polls fast AND ignores the hacking-level gate. */
  richCash: number;
  /** Re-check this often (ms) while rich and any opener is still missing. Evaluated against LIVE cash every
   * tick, so the window right after an install — broke at first, rich a minute later — is picked up as soon
   * as the gang refills the bank instead of waiting out a full slow interval. */
  richPollMs: number;
}

/**
 * When to install queued augs and reset. THREE independent triggers, any of which fires (see
 * `singularity/install.ts`) — a flat count alone is a poor proxy for "we have got what this cycle can give".
 *
 * All counts are of REAL augs: NeuroFlux levels are excluded, because `queueAugmentation` exempts NFG from
 * its duplicate check and pushes one queue entry PER LEVEL. A raw queue length is therefore mostly NFG in
 * any run with `neuroFluxDump` on, and "8 queued" can mean zero actual augmentations.
 */
export interface InstallStrategy {
  /** Install automatically when a trigger is met; false => prepare and wait for a manual go. */
  autoInstall: boolean;
  /** TRIGGER 1 (count): reset once this many real augs are queued. The plain "big enough batch" case. */
  minAugsQueued: number;
  /** ...and at least this much spent on them since the last install, so a batch of cheap augs does not
   * trigger a reset on its own. 0 disables the check. Accumulated by augs.js into INSTALL_FILE. */
  minSpend: number;
  /** TRIGGER 2 (stalled): reset when nothing further is purchasable — every remaining aug is either out
   * of rep we cannot donate for, or out of money at its escalated price. Waiting longer gains nothing:
   * `1.9^queued` only resets at an install. */
  installWhenStalled: boolean;
  /** TRIGGER 3 (favor): reset when the rep we are holding would carry some faction over the donation
   * favor gate. That converts the faction's rep from a time cost into a money cost for the rest of the
   * BitNode, which is worth more than the augs still behind it. See `lib/favor.ts`. */
  favorInstall: boolean;
  /** Floor for triggers 2 and 3 — never reset for fewer than this many real augs, however stalled or
   * favor-rich we are. Trigger 1 ignores this (it is already a count). */
  minAugsAnyTrigger: number;
}

/** Node-advance (leaving the BitNode). */
export interface EndgameStrategy {
  /** How to take the final step once the Red Pill is in and hacking has re-climbed to the daemon req.
   * true  => `destroyW0r1dD43m0n(nextNode)`: auto-jump straight into the next BitNode.
   * false => (default) root + BACKDOOR w0r1d_d43m0n, which opens the BitVerse and WAITS for you to pick the
   *          next node — fully unattended up to the choice, but commits to nothing (leaving is a big call). */
  autoDestroy: boolean;
  /** Which BitNode to enter next. */
  nextNode: number;
  /** Hacking level to backdoor w0r1d_d43m0n = 3000 * WorldDaemonDifficulty. BN4 => 9000. */
  hackReq: number;
  /** Once hacking reaches this FRACTION of hackReq, stop auto-installing — an install resets hacking to
   * ~1, so past this point the loop holds its augs and climbs the rest of the way uninterrupted (else the
   * infinite NeuroFlux queue would install forever and the climb would never finish). The key endgame
   * tuning knob: higher = more multipliers banked before the push (faster final climb, more resets first);
   * lower = push sooner with weaker mults (slower climb). Tune in-game. */
  pushFraction: number;
  /**
   * ABANDON the push when the projected time to reach `hackReq` exceeds this, and resume installing.
   *
   * `pushFraction` alone deadlocks. It stops installs at a fraction of the goal on the assumption that one
   * uninterrupted climb finishes the job — but if the run's hacking multiplier is too weak, the climb
   * asymptotes short of the target and the loop holds installs FOREVER, still earning faction rep it now
   * never spends (rep is wiped by the install that never comes).
   *
   * The escape is a measurement, not a guess: sample real hacking XP over a window, compare against
   * `expForSkill(hackReq, mult)` (see `lib/skills.ts`), and project.
   *
   * TUNE THIS LOW. The instinct to be generous here is wrong, because the comparison is not "30 more minutes
   * versus give up" — it is `exp(target, mult)` versus `exp(target, betterMult)`, and that ratio is
   * `e^(target/32 * (1/mult - 1/betterMult))`. At target 9000, nudging the hacking multiplier from 8 to 10
   * divides the XP required by ~1,100x. A push that a decent aug batch cannot finish inside half an hour is
   * one that banking those augs would finish almost instantly, so waiting it out is nearly always the
   * expensive choice. The one real risk is abandoning into an install that banks no HACKING multiplier at
   * all — `install.minAugsAnyTrigger` is the floor that guards against that.
   */
  pushAbandonMs: number;
}

/** Home RAM auto-upgrade — dynamic, so the ceiling scales with the run's stage (= wealth). */
export interface HomeStrategy {
  /** Hard maximum home RAM — never upgrade past this. 0 disables auto-upgrade. */
  ramCap: number;
  /** Only take the next doubling when it costs at most this fraction of current cash. This is what makes
   * the effective ceiling STAGE-AWARE: early (cash-poor) home stays small so money goes to openers/augs;
   * as the economy grows the doublings become cheap and home rises on its own, up to `ramCap`. */
  costFraction: number;
  /** Ceiling for the PRE-INSTALL DUMP only (`home.js --dump`), which is a different economic situation
   * from normal operation. `ramCap` and `costFraction` exist to pace spending while money still has other
   * uses; at the reset it has none — unspent cash becomes $1,000 — so the dump ignores both and runs to
   * this ceiling instead. Home RAM and cores are among the very few things that SURVIVE an install, which
   * is what makes them the right last resort. Set equal to `ramCap` to disable the RAM half of the dump. */
  dumpRamCap: number;
}

export interface Strategy {
  /** Stack keys bootstrap should NOT launch in this node. Computed from `ports.BN_DISABLE`. */
  disabledSubsystems: string[];
  route: RouteStrategy;
  crime: CrimeStrategy;
  augs: AugStrategy;
  rep: RepStrategy;
  programs: ProgramStrategy;
  install: InstallStrategy;
  endgame: EndgameStrategy;
  home: HomeStrategy;
}

/** A node override may replace any subset of a section. `disabledSubsystems` is NOT overridable here —
 * it always comes from BN_DISABLE so there is one source of truth. */
type StrategyOverride = {
  [K in Exclude<keyof Strategy, 'disabledSubsystems'>]?: Partial<Strategy[K]>;
};

/** Generic hacking-money node: no gang, buy hacking augs, notify before leaving. Overridden per node. */
const DEFAULT: Omit<Strategy, 'disabledSubsystems'> = {
  route: {
    primary: 'hacking',
    gangIfFree: true,
  },
  crime: {
    // DERIVED — `strategyFor` overwrites this from `route.primary`. The value here is only the shape.
    needGang: false,
    karmaTarget: -54000,
    homicideChanceSwitch: 0.5,
    gymStatTarget: 120,
  },
  augs: {
    cashReserve: 10e6,
    neuroFluxDump: true,
  },
  rep: {
    donate: true,
    donateBudgetFraction: 0.5,
    donateNeuroFlux: true,
    favorPush: true,
    redPillFavorRoute: true,
    combatGate: { faction: '', combat: 0, hacking: 0, money: 0, augs: 0 },
    companyRepPhase: false,
    cityBloc: 'none',
    companyTargets: [],
  },
  programs: {
    richCash: 1e9,
    richPollMs: 30_000,
  },
  install: {
    autoInstall: true,
    minAugsQueued: 4,
    minSpend: 0,
    installWhenStalled: true,
    favorInstall: true,
    minAugsAnyTrigger: 3,
  },
  endgame: {
    autoDestroy: false,
    nextNode: 1,
    hackReq: 3000, // WorldDaemonDifficulty 1
    pushFraction: 0.7,
    pushAbandonMs: 1_800_000, // 30 min projected — beyond that, bank multipliers and re-climb instead
  },
  home: {
    ramCap: 512, // hard ceiling for NORMAL operation; the cost gate below is the real limiter until the economy is large
    costFraction: 0.2, // take a doubling only when it's <= 20% of current cash
    dumpRamCap: 1 << 20, // 1,048,576 GB — effectively unbounded; doubling costs terminate the dump long first
  },
};

/** Per-BitNode deltas from DEFAULT. Only fields that differ from the generic node appear here. */
const OVERRIDES: Record<number, StrategyOverride> = {
  // BN1 "Source Genesis": the CHEAPEST node in the game and the only one that penalizes nothing — its whole
  // multiplier block is default, so ScriptHackMoney, HackExpGain, GangSoftcap, CrimeMoney, HacknetNodeMoney
  // and AugmentationMoneyCost are all 1. The first node where the stack is not fighting the node.
  //
  // `hackReq` and `nextNode` are deliberately ABSENT: BN1 IS the generic node DEFAULT describes
  // (WorldDaemonDifficulty 1 -> hacking 3000, `nextNode: 1`), and restating them here would be a second
  // copy to drift. The three fields below are the only real deltas.
  //
  // Why we come back: SF-1 is +16% / +24% / +28% to ALL multipliers, and we hold only level 1. Two clears
  // buy +12pp on every multiplier in the game — hacking, combat, money, rep, crime, hacknet — permanently,
  // for the shortest runs available. Sharpen the axe before a hard node. SF caps at level 3 (RedPill.tsx:
  // `lvl >= 3 && bitNodeNumber !== 12` just prints "already at max level"), so this is worth exactly two
  // runs and a third would grant nothing.
  1: {
    // NO GANG HERE, and this reverses the earlier call. BN1 does not bypass the -54k karma gate (only
    // `bitNodeN === 2` does), so a gang would cost the ~10-17h homicide grind that BN4/BN5 paid — and in
    // those nodes it was worth it because hacking was throttled to 20% / 15%. BN1 throttles NOTHING, so the
    // daemon is the economy from minute one and the grind buys an income stream we already have.
    //
    // The decisive part is what `needGang: true` COSTS: `singularity.ts` gates all of P2/P3 behind the gang,
    // so the whole grind runs with augs unbought, rep unworked and installs held. Measured live 2026-08-02:
    // $2.7b idle, 15k NiteSec rep unspent and 31 purchasable augs across four already-joined factions, none
    // of it reachable. Daedalus needs 30 augs / $100b / hacking 2500 (FactionInfo.tsx) — those 31 cover the
    // gate on their own, so the Red Pill path closes without a gang at all.
    route: { primary: 'hacking' },
    // The binding constraint here is NOT hacking: Daedalus wants 30 augs / $100b / hacking 2500 against a
    // daemon req of only 3000, so the aug COUNT arrives last. The megacorp path is what widens the aug
    // supply enough to reach 30, which is why it is on despite the short climb.
    rep: {
      companyRepPhase: true,
      companyTargets: ['Bachman & Associates', 'OmniTek Incorporated', 'Clarke Incorporated', 'Four Sigma'],
      // EASTERN, and the deciding factor is not the score table. Measured 2026-08-02: 13 augs installed
      // and only 8 more reachable without joining anything new, against a DaedalusAugsRequirement of 30 —
      // so the count gate is genuinely binding and every extra faction counts. Eastern brings the most
      // marginal augs (3, vs western 2 and volhaven 1) AND its cities are where Tian Di Hui's invite
      // lives, so one trip collects both. Western would cost a second journey for strictly less.
      cityBloc: 'eastern',
    },
    // Same re-bootstrap-tax logic as BN4/BN5. Tunable: with no AugmentationMoneyCost penalty here, smaller
    // batches bank multipliers sooner and might beat 8 — worth measuring across the two runs.
    install: { minAugsQueued: 8 },
  },
  // BN4 "The Singularity": the gang is the economy (GangSoftcap 1). Found it via a -54k karma crime
  // grind, pivot augs to hacking to drive level -> 9000, then leave for another BN4 run until SF-4.3.
  // Verified BN4 multipliers: CrimeSuccessRate 1 (homicide reaches full odds), WorldDaemonDifficulty 3.
  4: {
    route: { primary: 'gang' },

    // Grind order from /probe/aug-priority.js, exclusive augs first. Bachman leads (SmartJaw — a
    // rep-booster + charisma that only it sells); OmniTek/Clarke for their hacking augs. Four Sigma is
    // LAST because its ADR-V rep-boosters are sold by many factions and get owned early — repwork skips a
    // company whose augs we already own, so it costs nothing to keep it as a fallback. Trim as you like.
    rep: {
      companyRepPhase: true,
      companyTargets: ['Bachman & Associates', 'OmniTek Incorporated', 'Clarke Incorporated', 'Four Sigma'],
      // ILLUMINATI, for QLink — `hacking: 1.75` on top of hacking_speed 2 / chance 2.5 / money 4. The daemon
      // climb is exponential in `level / mult` (lib/skills.ts), so a 1.75x hacking multiplier is worth more
      // to reaching 9000 than any amount of extra grinding: it cuts the XP needed by orders of magnitude.
      // Verified invite gate: 30 augs installed, $150b, hacking 1500, and ALL FOUR combat skills at 1200.
      // Combat is the only one the hacking loop would never satisfy on its own, hence this step.
      //
      // QLink itself then costs 1.875M Illuminati rep and $25 TRILLION — the real barrier, and why the
      // favor route matters: banking Illuminati favor over several cycles turns that rep into a cash
      // purchase instead of a grind that has to fit inside one install cycle.
      combatGate: { faction: 'Illuminati', combat: 1200, hacking: 1500, money: 150e9, augs: 30 },
    },
    // autoDestroy OFF (default): once the Red Pill is in and hacking re-climbs to 9000, root + BACKDOOR
    // w0r1d_d43m0n — this opens the BitVerse and STOPS. It does NOT enter a new BitNode; you pick a node
    // (or not) yourself. That's the wanted behaviour: get the daemon backdoored, don't auto-start a run.
    // (true would call destroyW0r1dD43m0n to auto-jump — and it needs ~40 GB free home for the 32 GB call,
    // which doesn't fit next to the controller+daemon on a modest home anyway.)
    endgame: { nextNode: 4, hackReq: 9000 },
    // (home uses the default dynamic gate: rises with wealth up to 512 GB, so it ends the RAM squeeze on
    // its own once the gang is earning, without starving the early cash-poor bootstrap.)
    // Install in bigger batches: an aug-install RESETS money, stats, hacking level, port openers and
    // purchased servers (only home RAM, aug multipliers and the gang survive), so each one pays a
    // re-bootstrap tax. 8 amortizes that; most-expensive-first buying keeps the 1.9× escalation in check.
    install: { minAugsQueued: 8 },
  },

  // BN5 "Artificial Intelligence": the CHEAPEST exit left — WorldDaemonDifficulty 1.5 => hacking 4500,
  // against BN4's 9000 and BN2's 15000. Verified BN5 multipliers: ScriptHackMoney 0.15, HackExpGain 0.5,
  // AugmentationMoneyCost 2, HacknetNodeMoney 0.2, CrimeMoney 0.5, CloudServerSoftcap 1.2,
  // GangUniqueAugs 0.5. Note what is ABSENT: no GangSoftcap penalty and no HackingLevelMultiplier
  // penalty, so the gang runs at full strength and the climb to 4500 is honest.
  //
  // Why we come here: SF-5 grants Formulas.exe on EVERY prestige (`Prestige.ts` pushes it from both
  // `prestigeSourceFile` and `prestigeAugmentation` when `canAccessBitNodeFeature(5)`). Programs
  // otherwise die on entering a BitNode, so today `rank-formulas.ts` is dead code that would cost $5b
  // per run to wake up; after SF-5 it is the permanent path from second zero, with no post-install
  // window. SF-5 also grants `getBitNodeMultipliers()` and permanent Intelligence.
  5: {
    // ScriptHackMoney 0.15 means hacking is not the economy here either — the gang is. BN5 does NOT
    // bypass the karma gate (only `bitNodeN === 2` does), so this is the same -54k homicide cold start
    // as BN4, driven by singularity/crime.ts.
    route: { primary: 'gang' },
    // AugmentationMoneyCost 2: every aug costs double, so keep more liquid and install in bigger
    // batches to amortize the re-bootstrap tax over fewer resets.
    augs: { cashReserve: 20e6 },
    install: { minAugsQueued: 8 },
    rep: {
      companyRepPhase: true,
      companyTargets: ['Bachman & Associates', 'OmniTek Incorporated', 'Clarke Incorporated', 'Four Sigma'],
      // combatGate deliberately LEFT AT THE EMPTY DEFAULT. The Illuminati/QLink detour exists to make
      // BN4's 9000 climb tractable — it is worth many cycles only because the XP needed is exponential
      // in `level / mult`. At 4500 with no HackingLevelMultiplier penalty the ordinary aug batch should
      // carry the push. Turn it on only if `pushAbandonMs` actually fires in practice.
    },
    // autoDestroy OFF (default), so `nextNode` is inert: we backdoor w0r1d_d43m0n, the BitVerse opens,
    // and the node choice stays manual. The plan is ONE BN5 clear (SF-5.1 is where Formulas.exe and
    // getBitNodeMultipliers live; levels 2/3 only raise the hacking multiplier bonus 8% -> 12% -> 14%),
    // then reassess — so do not assume a repeat run.
    endgame: { nextNode: 5, hackReq: 4500 }, // 3000 * WorldDaemonDifficulty (1.5)
  },
};

/** Shallow-merge one override section onto its default. Sections are flat, so this is enough.
 *
 * NOTE it returns `base` ITSELF when there is no override — the module-level DEFAULT object, shared by
 * every caller. Never mutate a merged section; build a new one. */
function mergeSection<T>(base: T, over: Partial<T> | undefined): T {
  return over ? { ...base, ...over } : base;
}

/** `w0r1dd43m0n`'s hacking requirement before the node's own scaling. From `Server/data/servers.ts`
 * (`requiredHackingSkill: 3000`), multiplied by `BitNodeMultipliers.WorldDaemonDifficulty`. */
const WORLD_DAEMON_BASE_REQ = 3000;

/**
 * Hacking income relative to BN1, below which the action slot is better spent founding a gang than
 * working faction rep. Both terms scale daemon income multiplicatively, so their product is the honest
 * measure: `ScriptHackMoney × ServerMaxMoney`.
 *
 * Fitted to the four nodes we have actually played, which is the only evidence available:
 *   BN1  1.00 × 1.00 = 1.00  -> hacking   (played: gang was a 10-17h detour we did not need)
 *   BN2  1.00 × 0.08 = 0.08  -> gang      (played gang)
 *   BN4  0.20 × 1.00 = 0.20  -> gang      (played gang)
 *   BN5  0.15 × 1.00 = 0.15  -> gang      (played gang)
 * BN10 sits exactly on 0.50 and is the one to watch — treat its verdict as unproven.
 *
 * It is a judgement call fitted to four points, not a law. Any node can override `route` explicitly.
 */
const HACK_ROUTE_FLOOR = 0.5;
/** Below this, the gang is itself throttled hard enough (BN13 is 0.3) that its cold start cannot repay
 * the slot time even where hacking is also poor — so stay on hacking and accept a slow node. */
const GANG_VIABLE_SOFTCAP = 0.5;

/**
 * The route this node's multipliers argue for, ignoring any hand-written override. PURE (0 GB).
 *
 * Exported so `probe/bitnode.js` can print it for a node you are NOT in — which is the only cheap way to
 * check the heuristic, since every node we have played also carries an explicit `OVERRIDES.route` that
 * masks it. `run /probe/bitnode.js 4` must say `gang`, because that is how we actually played BN4.
 *
 * Missing fields fall back to 1.0 (the BN1-neutral value), so an older probe's record degrades toward
 * "hacking" — the route that needs no 10-17h cold start and is therefore the safer thing to guess wrong.
 */
export function deriveRoute(mults: BitNodeMults): Route {
  const hack = mults.ScriptHackMoney ?? 1;
  const maxMoney = mults.ServerMaxMoney ?? 1;
  const gangCap = mults.GangSoftcap ?? 1;
  if (!Number.isFinite(hack) || !Number.isFinite(maxMoney) || !Number.isFinite(gangCap)) return 'hacking';
  return hack * maxMoney < HACK_ROUTE_FLOOR && gangCap >= GANG_VIABLE_SOFTCAP ? 'gang' : 'hacking';
}

/**
 * The active strategy for `node`. PURE (0 GB) — no NS calls and no NS-named identifiers, which is what
 * lets all eight callers import it for nothing. Pass `ns.getResetInfo().currentNode`.
 *
 * `mults` is the LIVE BitNode multipliers, optional, injected by the caller — read them free with
 * `readBitNodeMults` from `lib/bitnode` (`ns.getBitNodeMultipliers` is 4 GB and needs SF-5, so it is
 * paid once by `probe/bitnode.js` and shared through a file). Do NOT reach for them inside this
 * function; that would cost every importer 4 GB and break the purity the whole design rests on.
 * Every field is optional — an older probe's record legitimately lacks fields added later — so each
 * one is guarded at its point of use rather than validated as a block.
 *
 * Precedence is DEFAULT -> OVERRIDES -> live multipliers, and the last step outranks the hand-written
 * config **for facts but not for preferences**:
 *
 * - `hackReq` is a FACT about the node, so measured always beats remembered.
 * - `route` is a PREFERENCE, so an explicit `OVERRIDES[n].route` always beats the derivation. The
 *   derivation only fills in nodes nobody has judged yet.
 *
 * The hardcodes stay as the fail-safe for the window before the probe has run in a fresh BitNode, and
 * for a run without SF-5. Omitting `mults` reproduces the pre-derivation behaviour exactly.
 */
export function strategyFor(node: number, mults?: BitNodeMults): Strategy {
  const o = OVERRIDES[node] ?? {};
  let disabledSubsystems = [...(BN_DISABLE[0] ?? []), ...(BN_DISABLE[node] ?? [])];
  let endgame = mergeSection(DEFAULT.endgame, o.endgame);
  let route = mergeSection(DEFAULT.route, o.route);

  if (mults) {
    // ROUTE: derived only when the node has not been judged by hand. `o.route?.primary` is the explicit
    // verdict and always wins — the derivation exists for nodes we have never played, not to second-guess
    // one we have.
    if (o.route?.primary === undefined) route = { ...route, primary: deriveRoute(mults) };

    // Derived, not configured. BN1 1.0 -> 3000, BN5 1.5 -> 4500, BN4 3 -> 9000, BN2 5 -> 15000.
    const wdd = mults.WorldDaemonDifficulty;
    if (wdd !== undefined && Number.isFinite(wdd) && wdd > 0) {
      endgame = { ...endgame, hackReq: WORLD_DAEMON_BASE_REQ * wdd };
    }
    // Purchased servers are not merely expensive here, they are IMPOSSIBLE (`ns.cloud.purchaseServer`
    // can never succeed), so auto-buy could only poll forever. BN9 is the node this exists for. Kept to
    // this one rule on purpose: it is a hard capability fact. Judgement calls like "is hacknet worth its
    // RAM at 20% production" stay in BN_DISABLE where a human decided them — and a `--<key>` flag still
    // overrides either, so nothing here can lock a subsystem off against your wishes.
    if (mults.CloudServerLimit === 0 && !disabledSubsystems.includes('auto-buy')) {
      disabledSubsystems = [...disabledSubsystems, 'auto-buy'];
    }
  }

  return {
    disabledSubsystems,
    route,
    // `needGang` is DERIVED from the route and overwritten unconditionally, so the two can never
    // disagree. Setting `crime.needGang` in OVERRIDES has no effect — set `route.primary` instead.
    crime: { ...mergeSection(DEFAULT.crime, o.crime), needGang: route.primary === 'gang' },
    augs: mergeSection(DEFAULT.augs, o.augs),
    rep: mergeSection(DEFAULT.rep, o.rep),
    programs: mergeSection(DEFAULT.programs, o.programs),
    install: mergeSection(DEFAULT.install, o.install),
    endgame,
    home: mergeSection(DEFAULT.home, o.home),
  };
}
