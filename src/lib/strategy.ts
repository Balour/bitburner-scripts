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
import { BN_DISABLE } from './ports';

/** Which augment family the buyer weights first. Phase-dependent in practice: a gang node
 * grinds combat early (faster homicide) then pivots to hacking (level -> daemon requirement). */
export type AugFocus = 'hacking' | 'combat' | 'money';

/** Cold-start crime -> gang path. Only nodes that must FOUND a gang via karma use this. */
export interface CrimeStrategy {
  /** Does this node reach its economy through a karma-founded gang? (BN4: yes.) */
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

/** Augment purchase priority + budget. */
export interface AugStrategy {
  /** Primary stat family to buy toward when funds are limited. */
  focus: AugFocus;
  /** Keep at least this much liquid; never spend the reserve on augs. */
  cashReserve: number;
  /** After the priced one-time augs, dump surplus into NeuroFlux Governor levels. */
  neuroFluxDump: boolean;
}

/** How reputation is earned to hit aug rep requirements. The controller compares candidates by
 * unlocked-aug-value per action-slot-second each cycle; these are the knobs that gate the choice. */
export interface RepStrategy {
  /** Favor at which `donateToFaction` unlocks — buy rep with money instead of the action slot. 150. */
  favorDonateThreshold: number;
  /** Allow the LATE company-rep path: `applyToCompany` -> `workForCompany` to a megacorp faction's
   * invite threshold -> join -> work its rep. Needs high stats to get hired, so it is gated off early
   * and turned on once the economy is mature. */
  companyRepPhase: boolean;
  /** Companies to grind (job → its faction unlock) when faction rep-work is exhausted, in priority. Each
   * is both a company and a faction of the same name. Four Sigma first — its augs boost faction rep. */
  companyTargets: string[];
}

/** When to install queued augs and reset. */
export interface InstallStrategy {
  /** Install automatically when the trigger is met; false => prepare and wait for a manual go. */
  autoInstall: boolean;
  /** Do not reset for a trivial batch — need at least this many augs queued. */
  minAugsQueued: number;
  /** ...and at least this much total spent, so a single cheap aug does not trigger a reset. */
  minSpend: number;
}

/** Node-advance (leaving the BitNode). */
export interface EndgameStrategy {
  /** Auto-destroy w0r1d_d43m0n when ready; false => notify and wait (default — leaving is a big call). */
  autoDestroy: boolean;
  /** Which BitNode to enter next. */
  nextNode: number;
  /** Hacking level to backdoor w0r1d_d43m0n = 3000 * WorldDaemonDifficulty. BN4 => 9000. */
  hackReq: number;
}

/** Home RAM auto-upgrade — dynamic, so the ceiling scales with the run's stage (= wealth). */
export interface HomeStrategy {
  /** Hard maximum home RAM — never upgrade past this. 0 disables auto-upgrade. */
  ramCap: number;
  /** Only take the next doubling when it costs at most this fraction of current cash. This is what makes
   * the effective ceiling STAGE-AWARE: early (cash-poor) home stays small so money goes to openers/augs;
   * as the economy grows the doublings become cheap and home rises on its own, up to `ramCap`. */
  costFraction: number;
}

export interface Strategy {
  /** Stack keys bootstrap should NOT launch in this node. Computed from `ports.BN_DISABLE`. */
  disabledSubsystems: string[];
  crime: CrimeStrategy;
  augs: AugStrategy;
  rep: RepStrategy;
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
  crime: {
    needGang: false,
    karmaTarget: -54000,
    homicideChanceSwitch: 0.5,
    gymStatTarget: 120,
  },
  augs: {
    focus: 'hacking',
    cashReserve: 10e6,
    neuroFluxDump: true,
  },
  rep: {
    favorDonateThreshold: 150,
    companyRepPhase: false,
    companyTargets: [],
  },
  install: {
    autoInstall: true,
    minAugsQueued: 4,
    minSpend: 0,
  },
  endgame: {
    autoDestroy: false,
    nextNode: 1,
    hackReq: 3000, // WorldDaemonDifficulty 1
  },
  home: {
    ramCap: 512, // hard ceiling; the cost gate below is the real limiter until the economy is large
    costFraction: 0.2, // take a doubling only when it's <= 20% of current cash
  },
};

/** Per-BitNode deltas from DEFAULT. Only fields that differ from the generic node appear here. */
const OVERRIDES: Record<number, StrategyOverride> = {
  // BN4 "The Singularity": the gang is the economy (GangSoftcap 1). Found it via a -54k karma crime
  // grind, pivot augs to hacking to drive level -> 9000, then leave for another BN4 run until SF-4.3.
  // Verified BN4 multipliers: CrimeSuccessRate 1 (homicide reaches full odds), WorldDaemonDifficulty 3.
  4: {
    crime: { needGang: true },
    augs: { focus: 'hacking' },
    // Grind order from /probe/aug-priority.js, exclusive augs first. Bachman leads (SmartJaw — a
    // rep-booster + charisma that only it sells); OmniTek/Clarke for their hacking augs. Four Sigma is
    // LAST because its ADR-V rep-boosters are sold by many factions and get owned early — repwork skips a
    // company whose augs we already own, so it costs nothing to keep it as a fallback. Trim as you like.
    rep: {
      companyRepPhase: true,
      companyTargets: ['Bachman & Associates', 'OmniTek Incorporated', 'Clarke Incorporated', 'Four Sigma'],
    },
    endgame: { nextNode: 4, hackReq: 9000 },
    // (home uses the default dynamic gate: rises with wealth up to 512 GB, so it ends the RAM squeeze on
    // its own once the gang is earning, without starving the early cash-poor bootstrap.)
    // Install in bigger batches: an aug-install RESETS money, stats, hacking level, port openers and
    // purchased servers (only home RAM, aug multipliers and the gang survive), so each one pays a
    // re-bootstrap tax. 8 amortizes that; most-expensive-first buying keeps the 1.9× escalation in check.
    install: { minAugsQueued: 8 },
  },
};

/** Shallow-merge one override section onto its default. Sections are flat, so this is enough. */
function mergeSection<T>(base: T, over: Partial<T> | undefined): T {
  return over ? { ...base, ...over } : base;
}

/** The active strategy for `node`. PURE (0 GB): pass `ns.getResetInfo().currentNode`. The disabled-subsystem
 * list is the union of BN_DISABLE's global key 0 and this node, matching bootstrap's existing resolution. */
export function strategyFor(node: number): Strategy {
  const o = OVERRIDES[node] ?? {};
  return {
    disabledSubsystems: [...(BN_DISABLE[0] ?? []), ...(BN_DISABLE[node] ?? [])],
    crime: mergeSection(DEFAULT.crime, o.crime),
    augs: mergeSection(DEFAULT.augs, o.augs),
    rep: mergeSection(DEFAULT.rep, o.rep),
    install: mergeSection(DEFAULT.install, o.install),
    endgame: mergeSection(DEFAULT.endgame, o.endgame),
    home: mergeSection(DEFAULT.home, o.home),
  };
}
