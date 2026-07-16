import type { NS } from '@ns';
import { VERSION } from './lib/ports';

/**
 * ~7.2 GB (hacknet.* are ~0.5 GB each, not free — verified by the budget probe). Mops SURPLUS
 * cash into hacknet nodes, best-payback-first. A bridge income, not an
 * engine: in BN2 hacknet isn't nerfed (unlike hacking), and its production is untouched by the
 * BitNode, so idle cash the gang can't yet absorb earns something here instead of nothing.
 *
 * ROI, from the real formulas (production = level*1.5*1.035^(ram-1)*(cores+5)/6 * yourMult):
 *   - LEVEL upgrades are the best ROI and stay cheap to ~L100 (minutes-to-hours payback).
 *   - NEW nodes are worth it for the first ~5 (cost x1.85 each, so payback balloons after).
 *   - RAM/CORES only pay off once a node is high-level (they multiply an already-large base), so
 *     the payback gate buys them only when cheap relative to that node's output — your "first few
 *     if inexpensive". Hard caps below keep them from ever chasing the expensive tail.
 * Hacknet scales LINEARLY with money in; the gang scales exponentially, so this wins the early-mid
 * game and the gang overtakes it. Retire it (raise CASH_FLOOR) once the gang eats billions.
 *
 * Not covered: hacknet augmentations (from Netburners) boost production, but they're personal augs
 * — manual to buy (no Singularity in BN2), and they wipe on install. Grab them by hand if you join
 * Netburners; not worth scripting for a bridge tool.
 *
 * Run: `run /hacknet.js`
 */
const REV = 'v3';

/** Only spend cash ABOVE this. Kept LOW so hacknet bootstraps fast after an install — augment
 * installs wipe hacknet (prestigeAugmentation: hacknetNodes.length = 0), the gang produces $0 while
 * it earns respect on Terrorism, and your money resets, so hacknet rebuilding the money engine is
 * the priority and the only competing claim early is your own manual mugging. The gang survives
 * installs with its gear (only ascension wipes gear), so it needs no cash here. Late-game this low
 * floor is harmless: the payback gate stops hacknet once it's maxed, so it won't drain a big pile.
 * Raise it only while deliberately banking cash for a large personal-augment batch. */
const CASH_FLOOR = 5e6;
/** The ROI gate IS the ceiling: never buy an upgrade that takes longer than this to pay for itself.
 * This is the knob — lower it to invest less in hacknet, raise it to push harder. Fixed level/ram/
 * core caps turned out to be the wrong tool: a node's leveling and RAM ROI *improve* as its other
 * stats grow (production is higher, so each step pays back faster), so a flat "stop at level 100"
 * blocks upgrades that still clear this gate. Let payback decide per node, live. */
const MAX_PAYBACK_SEC = 3 * 3600;
/** These are the game's hard maxima, not tuning caps — the API returns Infinity past them, which the
 * payback filter drops anyway. Lower any of them only if you want a hard stop BELOW the ROI gate. */
const MAX_NODES = 30;
const LEVEL_CAP = 200;
const RAM_CAP = 64;
const CORE_CAP = 16;
const CYCLE_MS = 10_000;

const GAIN_PER_LEVEL = 1.5; // HacknetNodeConstants.MoneyGainPerLevel

interface Buy {
  kind: 'node' | 'level' | 'ram' | 'core';
  index: number;
  cost: number;
  gain: number; // marginal $/sec this purchase adds
}

/** Effective production multiplier (your hacknet mult x the BitNode's), backed out of an existing
 * node so we needn't pay for getPlayer: production = base(level,ram,cores) * effMult. */
function effMult(ns: NS): number {
  const s = ns.hacknet.getNodeStats(0);
  const base = s.level * GAIN_PER_LEVEL * Math.pow(1.035, s.ram - 1) * ((s.cores + 5) / 6);
  return base > 0 ? s.production / base : 1;
}

/** Every purchase currently available, each with its marginal $/sec. Gains come from the production
 * formula's structure: level is linear (add production/level), ram doubling multiplies the mult by
 * 1.035^ram, a core takes (cores+5)/6 -> (cores+6)/6. */
function candidates(ns: NS): Buy[] {
  const n = ns.hacknet.numNodes();
  const list: Buy[] = [];

  if (n < MAX_NODES && n < ns.hacknet.maxNumNodes()) {
    // A fresh node is L1/R1/C1. With no node yet to back out the mult, force-buy the first (~$1k)
    // by treating its gain as infinite; after that we can estimate a new node's output honestly.
    const gain = n === 0 ? Infinity : GAIN_PER_LEVEL * effMult(ns);
    list.push({ kind: 'node', index: -1, cost: ns.hacknet.getPurchaseNodeCost(), gain });
  }

  for (let i = 0; i < n; i++) {
    const s = ns.hacknet.getNodeStats(i);
    if (s.level < LEVEL_CAP) {
      list.push({ kind: 'level', index: i, cost: ns.hacknet.getLevelUpgradeCost(i, 1), gain: s.production / s.level });
    }
    if (s.ram < RAM_CAP) {
      const gain = s.production * (Math.pow(1.035, s.ram) - 1);
      list.push({ kind: 'ram', index: i, cost: ns.hacknet.getRamUpgradeCost(i, 1), gain });
    }
    if (s.cores < CORE_CAP) {
      list.push({
        kind: 'core',
        index: i,
        cost: ns.hacknet.getCoreUpgradeCost(i, 1),
        gain: s.production / (s.cores + 5),
      });
    }
  }
  return list;
}

function execute(ns: NS, buy: Buy): boolean {
  switch (buy.kind) {
    case 'node':
      return ns.hacknet.purchaseNode() !== -1;
    case 'level':
      return ns.hacknet.upgradeLevel(buy.index, 1);
    case 'ram':
      return ns.hacknet.upgradeRam(buy.index, 1);
    case 'core':
      return ns.hacknet.upgradeCore(buy.index, 1);
    default:
      return false;
  }
}

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.print(`hacknet ${REV} [build ${VERSION}] starting`);

  for (;;) {
    // Buy every purchase that clears the payback gate, best-first, until the floor bites or nothing
    // qualifies. The guard is a runaway backstop; the caps and rising costs end it long before.
    for (let guard = 0; guard < 500; guard++) {
      const budget = ns.getServerMoneyAvailable('home') - CASH_FLOOR;
      if (budget <= 0) break;
      const viable = candidates(ns)
        .filter((b) => b.gain > 0 && b.cost <= budget && b.cost / b.gain <= MAX_PAYBACK_SEC)
        .sort((a, b) => a.cost / a.gain - b.cost / b.gain);
      if (viable.length === 0 || !execute(ns, viable[0])) break;
    }
    status(ns);
    await ns.sleep(CYCLE_MS);
  }
}

function status(ns: NS): void {
  const n = ns.hacknet.numNodes();
  let production = 0;
  for (let i = 0; i < n; i++) production += ns.hacknet.getNodeStats(i).production;
  ns.clearLog();
  ns.print(`hacknet ${REV} [build ${VERSION}]`);
  ns.print(`  nodes     ${n}/${MAX_NODES}`);
  ns.print(`  income    ${ns.format.number(production)}/sec`);
  ns.print(
    `  spends    surplus above ${ns.format.number(CASH_FLOOR)}; cash ${ns.format.number(ns.getServerMoneyAvailable('home'))}`,
  );
  ns.print(`  caps      L<=${LEVEL_CAP}, ram<=${RAM_CAP}, cores<=${CORE_CAP}, payback<=${MAX_PAYBACK_SEC / 3600}h`);
}
