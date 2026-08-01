import type { NS } from '@ns';

/**
 * Shared Singularity access for the automation loop. Two jobs, both about RAM:
 *
 * 1. **Hide the calls from the static parser.** `RamCalculations.ts` bills any `ns.singularity.foo`
 *    it sees — and it bills a bare property name `foo` read off ANY object if that name collides with
 *    an API (dot access on the returned object re-exposes the cost). So every call site must use
 *    STRING-LITERAL BRACKET access, which the parser cannot see (`s['purchaseTor']()`), exactly as
 *    `connect.ts` does. `sing(ns)` returns the namespace typed for autocomplete; callers MUST bracket it.
 *
 * 2. **Make the dynamically-costed calls payable.** Reservation only defers cost; the real RAM is
 *    charged at call time. `reserve()` raises `ramOverride` to cover it, CLAMPED to the running host's
 *    RAM. A fixed request is the trap: `connect.ts` asked for a flat 128 GB, home did not have it, the
 *    raise was REFUSED (leaving the ~3 GB static allocation intact and silently returning it), and the
 *    first `singularity.connect` died at 5.00 GB. Observed 2026-07-29; it now uses `reserve()` and
 *    declines cleanly. Always compare the RETURN of `reserve()` against what you need.
 *
 * Inside BN4 the Singularity multiplier is ×1, so base costs apply and modest reservations fit a 32 GB
 * home. Outside BN4 it is ×16/4/1 by SF-4 level — same code, raise `reserve()` and run on a fat host.
 * The exact live cost is a verify-in-game item (see the plan's verification section).
 */

/** The Singularity methods the loop uses. Params are loosely `string` (exact enum strings required at
 * runtime — v3 removed fuzzy matching) because bracket access bypasses strict typing anyway. Extend as
 * new phases need more of the namespace. */
export interface Sing {
  // programs / darkweb
  purchaseTor(): boolean;
  purchaseProgram(program: string): boolean;
  getDarkwebPrograms(): string[];
  getDarkwebProgramCost(program: string): number;
  // navigation / backdoor
  connect(host: string): boolean;
  getCurrentServer(): string;
  installBackdoor(): Promise<void>;
  // crime / training / travel (the player action slot)
  commitCrime(crime: string, focus?: boolean): number;
  getCrimeChance(crime: string): number;
  gymWorkout(gym: string, stat: string, focus?: boolean): boolean;
  travelToCity(city: string): boolean;
  stopAction(): boolean;
  isBusy(): boolean;
  isFocused(): boolean;
  // factions (instant — no action slot)
  checkFactionInvitations(): string[];
  joinFaction(faction: string): boolean;
  getFactionRep(faction: string): number;
  getFactionFavor(faction: string): number;
  /** Non-empty only if the faction offers work — which is also what makes it donatable. */
  getFactionWorkTypes(faction: string): string[];
  workForFaction(faction: string, type: string, focus?: boolean): boolean;
  /** Rejects (returns false, no money moved) if: not a member, it is your GANG's faction, the faction
   * offers no work types, amount <= 0, cash is short, or favor < `ns.getFavorToDonate()`. */
  donateToFaction(faction: string, amount: number): boolean;
  applyToCompany(company: string, field: string): string | null;
  workForCompany(company: string, focus?: boolean): boolean;
  // augments (instant)
  getAugmentationsFromFaction(faction: string): string[];
  getAugmentationPrice(aug: string): number;
  getAugmentationRepReq(aug: string): number;
  getAugmentationPrereq(aug: string): string[];
  getAugmentationBasePrice(aug: string): number;
  getAugmentationStats(aug: string): Record<string, number>;
  purchaseAugmentation(faction: string, aug: string): boolean;
  getOwnedAugmentations(purchased?: boolean): string[];
  installAugmentations(cbScript?: string): void;
  // home upgrades (instant). Both SURVIVE an augment install — `prestigeHomeComputer` clears programs,
  // network links, ramUsed and messages, and never touches `maxRam` or `cpuCores`. They reset only on
  // entering a new BitNode. Cores cap at 8; both are disabled by `bitNodeOptions.restrictHomePCUpgrade`,
  // which surfaces only as a `false` return, so always break on false rather than assuming affordability.
  upgradeHomeRam(): boolean;
  getUpgradeHomeRamCost(): number;
  upgradeHomeCores(): boolean;
  getUpgradeHomeCoresCost(): number;
  // endgame
  destroyW0r1dD43m0n(nextBN: number, cbScript?: string): void;
}

/** The Singularity namespace, typed. ALWAYS index it with a string literal at the call site. */
export function sing(ns: NS): Sing {
  return (ns as unknown as Record<string, unknown>)['singularity'] as Sing;
}

/**
 * Rep bought per dollar donated, MEASURED rather than derived. The game's formula
 * (`src/Faction/formulas/donation.ts`) is
 *     rep = amount / 1e6 * player.mults.faction_rep * BitNodeMultipliers.FactionWorkRepGain
 * and that last term is unreadable without SF-5 (`getBitNodeMultipliers`). Rather than hardcode a node's
 * value — 0.75 in BN4, 0.5 in BN2, 0.2 in BN14 — donate `probe` and read the rep delta. There is no
 * per-faction term, so ONE probe calibrates every faction, and it stays correct across a mid-run
 * faction_rep augment install.
 *
 * `faction` must already be donatable (member, favor gate met, offers work, not your gang's) — this does
 * not check, it just returns 0 if the donation is refused. Returns 0 on any failure, meaning "unusable".
 */
export function donationRate(ns: NS, s: Sing, faction: string, probe = 1e6): number {
  if (ns.getServerMoneyAvailable('home') < probe) return 0;
  const before = s['getFactionRep'](faction);
  if (!s['donateToFaction'](faction, probe)) return 0;
  const delta = s['getFactionRep'](faction) - before;
  return delta > 0 ? delta / probe : 0;
}

/**
 * Whether `host` already has a backdoor. `getServer` (2 GB, not Singularity, not tax-multiplied) is
 * reached via bracket access so the static parser never bills it — the cost is paid dynamically under
 * the caller's `reserve()`. Reading `.backdoorInstalled` is free (the field name is not an API).
 */
export function isBackdoored(ns: NS, host: string): boolean {
  const getServer = (ns as unknown as Record<string, (h: string) => { backdoorInstalled: boolean }>)['getServer'];
  return getServer(host).backdoorInstalled;
}

/**
 * Raise this script's RAM reservation to `gb` so bracket-hidden Singularity calls are payable, clamped
 * to what the running host actually has (never request more than exists, or the raise is refused and the
 * next call kills the script). Returns the resulting allocation. `host` defaults to where the script runs.
 *
 * RAISE-ONLY, and that is load-bearing. A caller may reserve for a cheap pass and later ask for more to
 * afford an optional expensive one (augs.ts does this twice: donations, then getAugmentationStats). The
 * host can be fuller at the second call than the first, which clamps the REQUEST below the allocation we
 * are already running under — and `ramOverride` happily accepts a reduction as long as it stays above the
 * dynamic high-water spent so far. That silently downgrades a healthy 30 GB reservation to whatever
 * happened to be free, the optional pass correctly declines, and then the ORIGINAL pass dies on a call it
 * had already paid for.
 *
 * Observed 2026-07-28 (BN5, overnight): augs.js held 30 GB, asked for 45 while home was full, got 12.10,
 * and was killed by `getAugmentationsFromFaction` at 14.35 GB — a call the 30 GB reservation covered.
 * So clamp UP to the current allocation: a raise that does not fit leaves the caller exactly as it was,
 * and `reserve(...) >= need` still reads false, which is what makes the optional pass skip cleanly.
 * `ramOverride()` with no argument reads the current limit without changing it, and costs 0 GB.
 */
export function reserve(ns: NS, gb: number, host?: string): number {
  const where = host ?? ns.getHostname();
  // ramOverride sets this script's TOTAL reservation and REFUSES (fatally) if the host lacks the free
  // RAM for it. Our own static cost is already counted in usedRam, so the most we can safely claim is
  // ownStatic + whatever is free. Never request more than that.
  const free = ns.getServerMaxRam(where) - ns.getServerUsedRam(where);
  const ownStatic = ns.getScriptRam(ns.getScriptName(), where);
  const affordable = Math.min(gb, ownStatic + Math.max(free, 0));
  return ns.ramOverride(Math.max(affordable, ns.ramOverride()));
}

/**
 * Reserve `gb`, but only proceed if we secured at least `need` (the script's true dynamic high-water).
 * Home can be momentarily full (daemon rank + gang helpers + the controller overlapping), which clamps
 * the reservation below what the script needs — then its first big call crashes with a RAM error. This
 * bails out cleanly instead, logging so it's visible; the controller re-launches the helper on its next
 * pass, when there's room. Returns true if OK to run.
 */
export function reserveOk(ns: NS, gb: number, need: number, host?: string): boolean {
  const got = reserve(ns, gb, host);
  if (got < need) {
    ns.print(`reserve: got ${got.toFixed(1)} GB, need ${need} — host too full right now, exiting to retry.`);
    return false;
  }
  return true;
}
