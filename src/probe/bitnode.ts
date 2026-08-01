import type { NS, BitNodeMultipliers } from '@ns';
import { BITNODE_FILE, VERSION } from '../lib/ports';
import type { BitNodeRecord } from '../lib/bitnode';

/**
 * 6.6 GB, one-shot. The ONLY script that pays for `ns.getBitNodeMultipliers` (4 GB, needs SF-5). Writes
 * this node's multipliers to `BITNODE_FILE` so `strategyFor` can be driven by measurement instead of the
 * hand-written OVERRIDES, and prints the ones that carry a decision.
 *
 * bootstrap runs it automatically when no record exists for the current BitNode. Multipliers are constant
 * for the life of a node, so that is exactly once per run — there is nothing to keep refreshed.
 *
 * ## Also a planning tool
 *
 * `getBitNodeMultipliers(n, lvl)` answers for ANY node, not just the one you are in. So
 * `run /probe/bitnode.js 10` prices BN10 before you commit hours to it — which multipliers it nerfs, what
 * its daemon requirement is, whether purchased servers exist there at all. Reading that off the live game
 * beats reading it off a wiki that may describe a different version. It does NOT overwrite the record
 * unless you asked about the node you are actually in.
 *
 * Run: `run /probe/bitnode.js`      this node — print and write the record
 *      `run /probe/bitnode.js 10`   price BN10 — print only
 */
const REV = 'v1';

/** Printed with the decision each one drives, because a bare number is not actionable. Everything else in
 * `BitNodeMultipliers` is real but nothing here reads it — see it with `--all`. */
const NOTABLE: [keyof BitNodeMultipliers, string][] = [
  ['WorldDaemonDifficulty', 'x3000 = the daemon hacking req -> strategy.endgame.hackReq'],
  ['CloudServerLimit', '0 = purchased servers IMPOSSIBLE -> auto-buy force-disabled'],
  ['ScriptHackMoney', 'daemon income vs BN1'],
  ['HackExpGain', 'how fast the hacking climb goes'],
  ['GangSoftcap', 'gang income — the economy in every node we run'],
  ['HacknetNodeMoney', 'is hacknet worth its 7.2 GB here'],
  ['CrimeMoney', 'P1 crime income during the karma grind'],
  ['AugmentationMoneyCost', 'aug prices -> augs.cashReserve, install.minAugsQueued'],
  ['HomeComputerRamCost', 'home upgrade prices -> home.costFraction'],
  ['FavorToDonateToFaction', 'scales the donation gate — never hardcode 150'],
];

export async function main(ns: NS) {
  const flags = ns.flags([['all', false]]);
  const asked = ns.args.find((a) => typeof a === 'number') as number | undefined;
  const here = ns.getResetInfo().currentNode;
  const node = asked ?? here;

  let mults: BitNodeMultipliers;
  try {
    // Throws without SF-5 (or being inside BN5). That is a fact worth RECORDING rather than retrying:
    // see the `ok: false` record below.
    mults = asked === undefined ? ns.getBitNodeMultipliers() : ns.getBitNodeMultipliers(asked);
  } catch (e) {
    ns.tprint(`WARN bitnode ${REV}: getBitNodeMultipliers unavailable (needs SF-5) — ${String(e)}`);
    if (node === here) {
      const rec: BitNodeRecord = { node: here, ok: false };
      ns.write(BITNODE_FILE, JSON.stringify(rec), 'w');
      ns.tprint('  recorded ok:false so bootstrap stops re-running this; strategyFor falls back to OVERRIDES.');
    }
    return;
  }

  ns.tprint('');
  ns.tprint(`=== bitnode ${REV} [build ${VERSION}] — BN${node}${node === here ? ' (current)' : ' (lookup)'} ===`);
  ns.tprint(`  daemon hacking req: ${3000 * mults.WorldDaemonDifficulty}`);

  const entries = flags['all']
    ? (Object.keys(mults) as (keyof BitNodeMultipliers)[]).map((k): [keyof BitNodeMultipliers, string] => [k, ''])
    : NOTABLE;
  for (const [key, why] of entries) {
    const v = mults[key];
    if (typeof v !== 'number') continue;
    // Flag anything that is NOT 1: those are the node's actual character, and the ones at 1 are noise.
    const mark = v === 1 ? '   ' : ' * ';
    ns.tprint(`  ${mark}${String(key).padEnd(26)} ${String(v).padStart(8)}${why ? `   ${why}` : ''}`);
  }
  if (!flags['all']) ns.tprint('  (--all for every multiplier)');

  // Only the node we are actually IN drives strategy. A lookup of some other node is for planning and must
  // never poison the record — writing BN10's numbers while sitting in BN1 would hand strategyFor a
  // hackReq of 6000 and stop the close-out from ever firing.
  if (node !== here) {
    ns.tprint(`  lookup only — record for BN${here} left untouched.`);
    ns.tprint('');
    return;
  }

  const rec: BitNodeRecord = {
    node: here,
    ok: true,
    mults: { WorldDaemonDifficulty: mults.WorldDaemonDifficulty, CloudServerLimit: mults.CloudServerLimit },
  };
  ns.write(BITNODE_FILE, JSON.stringify(rec), 'w');
  ns.tprint(`  wrote ${BITNODE_FILE} — strategyFor now derives hackReq from the live game.`);
  ns.tprint('');
}
