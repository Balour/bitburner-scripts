import type { NS } from '@ns';
import { BITNODE_FILE } from './ports';
import { strategyFor, type Strategy, type BitNodeMults } from './strategy';

/**
 * Live BitNode multipliers, read for FREE from the record `probe/bitnode.js` writes.
 *
 * `ns.getBitNodeMultipliers` is 4 GB and throws without SF-5, so the eight scripts that resolve a
 * strategy cannot each pay for it. One probe pays, writes `BITNODE_FILE`, and everyone else reads it with
 * `ns.read` (0 GB). Multipliers are constant for the life of a BitNode, so the record needs writing
 * exactly once per node — `node` keys it, and a record from the previous node reads as absent.
 *
 * Everything here is fail-SAFE toward the hardcoded config: unreadable, malformed, stale or `ok: false`
 * all return `undefined`, and `strategyFor` then behaves exactly as it did before this existed. Live data
 * is an UPGRADE over the hand-written OVERRIDES, never a dependency of them — a fresh BitNode has no
 * record until the probe runs, and the loop has to work in that window.
 *
 * DEPENDENCY DIRECTION: this module imports `lib/strategy`, never the reverse. `BitNodeMults` is declared
 * in strategy.ts (the consumer) precisely so these two do not form an import cycle.
 */

/**
 * The multiplier fields we persist and read back. ONE list, exported, so the probe writes exactly what
 * the reader validates — the two drifting apart is how a field silently reads back `undefined` forever.
 * Adding a field here plus the logic that consumes it in `strategyFor` is the whole change.
 */
export const MULT_KEYS = [
  'WorldDaemonDifficulty',
  'CloudServerLimit',
  'ScriptHackMoney',
  'ServerMaxMoney',
  'GangSoftcap',
  'DaedalusAugsRequirement',
] as const satisfies readonly (keyof BitNodeMults)[];

/** What the probe writes. `ok: false` records that the call was UNAVAILABLE (no SF-5), which is worth
 * persisting: without it bootstrap would re-run a 4 GB probe every reset to rediscover the same gap. */
export interface BitNodeRecord {
  node: number;
  ok: boolean;
  mults?: BitNodeMults;
}

/** The raw record for `node`, or undefined if none has been written for THIS BitNode yet. bootstrap uses
 * this (not `readBitNodeMults`) to decide whether to run the probe — `ok: false` is an answer, not a miss. */
export function readBitNodeRecord(ns: NS, node: number): BitNodeRecord | undefined {
  try {
    const raw = ns.read(BITNODE_FILE);
    if (!raw) return undefined;
    const o = JSON.parse(raw) as Partial<BitNodeRecord>;
    if (o.node !== node) return undefined; // written in a previous BitNode — stale by definition
    if (o.ok !== true) return { node, ok: false };
    const m = o.mults;
    if (!m || typeof m !== 'object') return { node, ok: false };

    // Copy field by field, keeping only finite numbers. PER-FIELD rather than all-or-nothing on purpose:
    // this record survives augment installs, so one written by an older probe legitimately lacks fields
    // added since, and discarding the whole thing over that would throw away the fields that ARE valid.
    // Dropping a bad field instead lets `strategyFor` fall back to a neutral 1.0 for just that decision.
    //
    // What must NEVER happen is a non-finite value reaching the consumer: `hackReq: NaN` compares false
    // against every threshold, which would silently disable close mode for the whole run.
    const mults: BitNodeMults = {};
    for (const key of MULT_KEYS) {
      const v = m[key];
      if (typeof v === 'number' && Number.isFinite(v)) mults[key] = v;
    }
    return { node, ok: true, mults };
  } catch {
    return undefined;
  }
}

/** Live multipliers for `node`, or undefined to fall back to the hardcoded OVERRIDES. 0 GB. */
export function readBitNodeMults(ns: NS, node: number): BitNodeMults | undefined {
  return readBitNodeRecord(ns, node)?.mults;
}

/**
 * `strategyFor` with the live multipliers already wired in. **This is the one every script should call** —
 * plain `strategyFor(node)` silently returns the hardcoded `hackReq` instead of the measured one, and a
 * caller has no way to notice. 0 GB: `strategyFor` is pure and this only adds an `ns.read`.
 *
 * It lives here rather than in `lib/strategy.ts` to keep that module free of `ns` entirely — the purity is
 * what lets all eight callers import it for nothing.
 */
export function liveStrategy(ns: NS, node: number): Strategy {
  return strategyFor(node, readBitNodeMults(ns, node));
}
