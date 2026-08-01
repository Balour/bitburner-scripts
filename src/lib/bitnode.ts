import type { NS, BitNodeMultipliers } from '@ns';
import { BITNODE_FILE } from './ports';
import { strategyFor, type Strategy } from './strategy';

/**
 * Live BitNode multipliers, read for FREE from the record `probe/bitnode.js` writes.
 *
 * `ns.getBitNodeMultipliers` is 4 GB and throws without SF-5, so the eight scripts that call
 * `strategyFor` cannot each pay for it. One probe pays, writes `BITNODE_FILE`, and everyone else reads
 * it with `ns.read` (0 GB). Multipliers are constant for the life of a BitNode, so the record needs
 * writing exactly once per node — `node` keys it, and a record from the previous node reads as absent.
 *
 * Everything here is fail-SAFE toward the hardcoded config: unreadable, malformed, stale or
 * `ok: false` all return `undefined`, and `strategyFor` then behaves exactly as it did before this
 * existed. Live data is an UPGRADE over the hand-written OVERRIDES, never a dependency of them — a
 * fresh BitNode has no record until the probe runs, and the loop has to work in that window.
 */

/** The subset we actually consume. Deliberately narrow: every field here has a decision attached to it,
 * so adding one should mean adding the logic that uses it. `Pick` keeps us honest against the real
 * `BitNodeMultipliers` — a renamed field in a game update becomes a compile error, not a silent 1.0. */
export type BitNodeMults = Pick<BitNodeMultipliers, 'WorldDaemonDifficulty' | 'CloudServerLimit'>;

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
    // Validate every consumed field individually. A partially-written record must degrade to "no data"
    // rather than hand `strategyFor` an undefined it would multiply into NaN — `hackReq: NaN` compares
    // false against everything, which would silently disable close mode forever.
    if (!m || !Number.isFinite(m.WorldDaemonDifficulty) || !Number.isFinite(m.CloudServerLimit)) {
      return { node, ok: false };
    }
    return {
      node,
      ok: true,
      mults: { WorldDaemonDifficulty: m.WorldDaemonDifficulty, CloudServerLimit: m.CloudServerLimit },
    };
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
 * It lives here rather than in `lib/strategy.ts` to keep that module free of `ns` entirely — the purity
 * is what lets all eight callers import it for nothing.
 */
export function liveStrategy(ns: NS, node: number): Strategy {
  return strategyFor(node, readBitNodeMults(ns, node));
}
