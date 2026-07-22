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
 *    RAM — `connect.ts`'s fixed `ramOverride(128)` refuses on a 32 GB home and the next call dies.
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
  workForFaction(faction: string, type: string, focus?: boolean): boolean;
  donateToFaction(faction: string, amount: number): boolean;
  applyToCompany(company: string, field: string): string | null;
  workForCompany(company: string, focus?: boolean): boolean;
  // augments (instant)
  getAugmentationsFromFaction(faction: string): string[];
  getAugmentationPrice(aug: string): number;
  getAugmentationRepReq(aug: string): number;
  getAugmentationPrereq(aug: string): string[];
  purchaseAugmentation(faction: string, aug: string): boolean;
  getOwnedAugmentations(purchased?: boolean): string[];
  installAugmentations(cbScript?: string): void;
  // home upgrades (instant)
  upgradeHomeRam(): boolean;
  getUpgradeHomeRamCost(): number;
  // endgame
  destroyW0r1dD43m0n(nextBN: number, cbScript?: string): void;
}

/** The Singularity namespace, typed. ALWAYS index it with a string literal at the call site. */
export function sing(ns: NS): Sing {
  return (ns as unknown as Record<string, unknown>)['singularity'] as Sing;
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
 * next call kills the script). Returns the resulting allocation. Call it ONCE, before the first
 * Singularity call. `host` defaults to where the script runs.
 */
export function reserve(ns: NS, gb: number, host?: string): number {
  const where = host ?? ns.getHostname();
  // ramOverride sets this script's TOTAL reservation and REFUSES (fatally) if the host lacks the free
  // RAM for it. Our own static cost is already counted in usedRam, so the most we can safely claim is
  // ownStatic + whatever is free. Never request more than that.
  const free = ns.getServerMaxRam(where) - ns.getServerUsedRam(where);
  const ownStatic = ns.getScriptRam(ns.getScriptName(), where);
  return ns.ramOverride(Math.min(gb, ownStatic + Math.max(free, 0)));
}
