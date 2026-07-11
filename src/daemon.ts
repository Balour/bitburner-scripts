import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { HACK_FRACTION, PORT_RANK, TARGETS_FILE, VERSION } from './lib/ports';

/**
 * 4.85 GB. Stage-2 controller: drain piles, sustain what grow can afford.
 *
 * NEVER import rank.ts — the parser follows imports and rank's analysis calls
 * (hackAnalyze, hackAnalyzeChance, growthAnalyze) would add 3 GB. Batch maths
 * arrives as data over a free port. No ns.getServer (2 GB), no *Analyze here.
 *
 * THREE MODES, CHOSEN PER SERVER PER ROUND
 * ----------------------------------------
 * These servers have tiny serverGrowth: refilling a 25% hack on a $57M server
 * needs ~700 grow threads (>1 TB). Whether that fits decides the mode:
 *
 *   - weaken to min security first (cheap, needed for hack chance/time)
 *   - PREP/SUSTAIN, if one whole batch fits the pool: grow to max (no hacking
 *     until PREP_DONE, so it climbs fast), then hold at max by hacking a slice
 *     and growing it straight back. One rich giant (harakiri) can claim most of
 *     the pool this way — the highest $/sec available.
 *   - DRAIN, if the refill does not fit: hack the sitting pile with no grow,
 *     extract what is there, abandon once emptied. Grow-bound piles, one-shot.
 *
 * Round-based: dispatch every target's ops, poll isRunning to completion, remeasure.
 * Not wall-clock — that is the legacy desync bug. Fire-and-forget flooding is also
 * gone; it clogged the pool with untracked jobs. Run: `run /daemon.js`
 */

const HACK_FILE = '/workers/hack.js';
const GROW_FILE = '/workers/grow.js';
const WEAKEN_FILE = '/workers/weaken.js';
const RANK_FILE = '/rank.js';
const ROOT_FILE = '/root.js';

const HACK_COST = 1.7;
const GROW_COST = 1.75;
const WEAKEN_COST = 1.75;

/** Security each thread moves, single core. hack/grow raise, weaken lowers. */
const HACK_SEC = 0.002;
const GROW_SEC = 0.004;
const WEAKEN_SEC = 0.05;

const SEC_SLACK = 0.5;
/** Stop hacking a server once its money falls below this share of max — a drained
 * grow-bound pile is not worth more hacks. */
const DRAIN_FLOOR = 0.03;
/** Skip draining a server whose single hack would take longer than this. The round
 * waits for its slowest op, so a slow high-reqSkill hack would gate everything;
 * these grow-bound piles are not worth stalling a giant's prep for. Milliseconds. */
const MAX_OP_MS = 60000;
/** A server can SUSTAIN (prep to max + maintain) only if one batch fits this share
 * of the pool. 0.9 lets a single rich giant claim most of the pool for sequential
 * batches — the harakiri play — while still refusing servers no pool can hold.
 * Everything that does not fit is DRAINED instead. */
const SUSTAIN_SHARE = 0.9;
/** Below this share of max money a sustain target is still PREPPING: grow only,
 * do not hack, so it climbs to max fast before we start harvesting it. */
const PREP_DONE = 0.9;
/** Cap on targets worked per round. High enough to cover every hackable server so
 * draining the top piles never leaves the daemon idle with richer piles untouched. */
const MAX_ACTIVE = 16;

const BREAKPOINTS = [10, 25, 50, 100, 250, 500, 1000];

interface Slot {
  host: string;
  free: number;
}

interface Batch {
  hackT: number;
  growT: number;
  weakenT: number;
  ram: number;
}

function poolOf(ns: NS, hosts: string[]): Slot[] {
  const slots: Slot[] = [];
  for (const host of hosts) {
    if (host === 'home') continue; // home runs the controllers + rank, not workers
    const capacity = ns.getServerMaxRam(host);
    if (capacity <= 0) continue;
    const free = capacity - ns.getServerUsedRam(host);
    if (free >= HACK_COST) slots.push({ host, free });
  }
  return slots.sort((a, b) => b.free - a.free);
}

function poolFree(slots: Slot[]): number {
  return slots.reduce((sum, slot) => sum + slot.free, 0);
}

/**
 * Spreads `want` threads across hosts, largest free first. One exec = one
 * N-thread process. Partial allocation is fine; the round re-measures. Mutates
 * `slots` so later dispatches in the same round do not oversubscribe.
 */
function dispatch(
  ns: NS,
  file: string,
  cost: number,
  want: number,
  target: string,
  slots: Slot[],
  copied: Set<string>,
): number[] {
  const pids: number[] = [];
  let left = want;
  for (const slot of slots) {
    if (left <= 0) break;
    const count = Math.min(Math.floor(slot.free / cost), left);
    if (count <= 0) continue;
    const key = `${slot.host}|${file}`;
    if (!copied.has(key)) {
      ns.scp(file, slot.host);
      copied.add(key);
    }
    const pid = ns.exec(file, slot.host, count, target);
    if (pid === 0) continue;
    pids.push(pid);
    slot.free -= count * cost;
    left -= count;
  }
  return pids;
}

async function awaitPids(ns: NS, pids: number[]) {
  if (pids.length === 0) return;
  while (pids.some((pid) => ns.isRunning(pid))) await ns.sleep(200);
}

/** One batch's thread counts. hackT steals HACK_FRACTION of current money; growT
 * (from rank's growthAnalyze) refills it plus a climb; the weakens cancel the
 * security both raise. */
function batchOf(t: Target): Batch {
  const hackT = Math.max(1, Math.floor(HACK_FRACTION / t.pctAtMin));
  const growT = Math.max(1, Math.round(t.growThreads));
  const weakenT = Math.max(1, Math.ceil((hackT * HACK_SEC + growT * GROW_SEC) / WEAKEN_SEC));
  const ram = hackT * HACK_COST + growT * GROW_COST + weakenT * WEAKEN_COST;
  return { hackT, growT, weakenT, ram };
}

function crossedBreakpoint(before: number, after: number): boolean {
  return BREAKPOINTS.some((mark) => before < mark && after >= mark);
}

async function reRank(ns: NS): Promise<Target[] | null> {
  // Runs on home: at 32 GB, daemon (4.8) + rank (5.45) + monitor (2.4) all fit,
  // so no remote host or scp is needed — rank reads its own imports from home.
  ns.clearPort(PORT_RANK);
  const pid = ns.exec(RANK_FILE, 'home', 1);
  if (pid === 0) return null;
  await awaitPids(ns, [pid]);

  const raw = ns.readPort(PORT_RANK);
  if (typeof raw !== 'string' || raw === 'NULL PORT DATA') {
    ns.print(`  rank: no data on port (rank.js failed — home short on RAM?)`);
    return null;
  }
  const targets = JSON.parse(raw) as Target[];
  ns.write(TARGETS_FILE, JSON.stringify(targets, null, 2), 'w');
  const top = [...targets].filter((t) => t.moneyScore > 0).sort((a, b) => b.moneyScore - a.moneyScore)[0];
  ns.print(
    `  rank: ${targets.length} servers, ${targets.filter((t) => t.moneyScore > 0).length} hackable` +
      (top ? `, top $ ${top.host}` : ''),
  );
  return targets;
}

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.print(`daemon ${VERSION} starting`);

  // Clear workers left by a previous run — orphans hitting the old target muddy
  // every measurement. Safe on pool hosts, never touches home.
  for (const host of rooted(ns, crawl(ns))) {
    if (host !== 'home') ns.killall(host);
  }

  const copied = new Set<string>();
  let targets: Target[] = [];
  let lastLevel = 0;
  let round = 0;

  const money$ = (n: number) => ns.format.number(n);

  while (true) {
    round += 1;
    const level = ns.getHackingLevel();

    if (targets.length === 0 || crossedBreakpoint(lastLevel, level)) {
      const rootPid = ns.exec(ROOT_FILE, 'home');
      if (rootPid !== 0) await awaitPids(ns, [rootPid]);

      ns.print(`re-rank at level ${level} (was ${lastLevel})`);
      const fresh = await reRank(ns);
      if (fresh) targets = fresh;
      lastLevel = level;
      if (targets.length === 0) {
        await ns.sleep(2000);
        continue;
      }
    }

    const hosts = rooted(ns, crawl(ns)).filter((h) => h !== 'home');
    const slots = poolOf(ns, hosts);
    const poolTotal = slots.reduce((sum, s) => sum + s.free, 0);
    const fitBudget = poolTotal * SUSTAIN_SHARE;

    // Classify every hackable server (money measured once). Round order:
    //   tier 0 — maxed sustainables: BATCH, they produce income, get the pool first
    //   tier 1 — prepping sustainables: grow-only, no income, capped to MAX_PREP
    //   tier 2 — drains: grow-bound piles, richest first
    // Within a tier, higher moneyScore first.
    const info = targets
      .filter((t) => t.moneyScore > 0)
      .map((t) => {
        const money = ns.getServerMoneyAvailable(t.host);
        const maxMoney = ns.getServerMaxMoney(t.host);
        const b = batchOf(t);
        const sustain = b.ram <= fitBudget;
        const maxed = sustain && money >= maxMoney * PREP_DONE;
        return { t, money, maxMoney, b, sustain, maxed };
      })
      .sort((a, b) => {
        const tier = (x: typeof a) => (x.sustain ? (x.maxed ? 0 : 1) : 2);
        return tier(a) - tier(b) || b.t.moneyScore - a.t.moneyScore;
      })
      .slice(0, MAX_ACTIVE);

    if (info.length === 0) {
      await ns.sleep(2000);
      continue;
    }

    const pids: number[] = [];
    const notes: string[] = [];
    // Income is home-money delta over the round: a sustained server is refilled by
    // its own grow before the round ends, so its on-server delta reads ~0 even
    // though the hack banked real cash. getServerMoneyAvailable('home') is the
    // player's wallet, so this captures both drain and batch income correctly.
    const homeBefore = ns.getServerMoneyAvailable('home');

    for (const x of info) {
      if (poolFree(slots) < HACK_COST) break;
      const { t, money, maxMoney, b } = x;
      const host = t.host;

      if (x.sustain) {
        // Only SUSTAIN targets get weakened to min — they need it to batch. NEVER
        // weaken a drain target: a reqSkill-100 server's weaken can take 10+ min
        // and, because the round waits for its slowest op, would gate everything.
        const curSec = ns.getServerSecurityLevel(host);
        if (curSec > t.minSec + SEC_SLACK) {
          const want = Math.ceil((curSec - t.minSec) / WEAKEN_SEC);
          const p = dispatch(ns, WEAKEN_FILE, WEAKEN_COST, want, host, slots, copied);
          pids.push(...p);
          notes.push(`weaken ${host} ${curSec.toFixed(1)}->${t.minSec.toFixed(1)} (${want}t)`);
          continue;
        }
        // A whole batch must fit the RAM still free, or its grow lands as a useless
        // handful. Highest-value targets are sorted first, so this greedily fills
        // the pool and naturally defers the rest — no fixed prep cap needed: on a
        // big pool everything fits, on a small one the overflow just waits its turn.
        if (b.ram > poolFree(slots)) {
          notes.push(`wait ${host} $${((100 * money) / maxMoney).toFixed(0)}%`);
          continue;
        }
        // PREP (below PREP_DONE): grow only, no hack, so it climbs to max fast.
        // MAINTAIN (at max): hack a slice and grow it straight back.
        const prepping = !x.maxed;
        const hackT = prepping ? 0 : b.hackT;
        const weakenT = Math.max(1, Math.ceil((hackT * HACK_SEC + b.growT * GROW_SEC) / WEAKEN_SEC));
        const hp = hackT > 0 ? dispatch(ns, HACK_FILE, HACK_COST, hackT, host, slots, copied) : [];
        const gp = dispatch(ns, GROW_FILE, GROW_COST, b.growT, host, slots, copied);
        const wp = dispatch(ns, WEAKEN_FILE, WEAKEN_COST, weakenT, host, slots, copied);
        pids.push(...hp, ...gp, ...wp);
        notes.push(
          `${prepping ? 'prep  ' : 'batch '}${host} $${((100 * money) / maxMoney).toFixed(0)}% (h${hackT} g${b.growT} w${weakenT})`,
        );
        continue;
      }

      // DRAIN: grow-bound pile, hack-only at whatever security it sits at. Skip if
      // empty, or if one hack would take longer than MAX_OP_MS — a slow hack gates
      // the whole round, and these piles are not worth stalling a giant's prep.
      if (money < maxMoney * DRAIN_FLOOR) {
        notes.push(`drained ${host}`);
        continue;
      }
      if (ns.getHackTime(host) > MAX_OP_MS) {
        notes.push(`skip ${host} (slow)`);
        continue;
      }
      dispatch(ns, HACK_FILE, HACK_COST, b.hackT, host, slots, copied);
      notes.push(`drain ${host} $${((100 * money) / maxMoney).toFixed(0)}% (h${b.hackT})`);
    }

    if (pids.length === 0) {
      await ns.sleep(1000);
      continue;
    }

    // Log the dispatch NOW, before awaiting — a round can take minutes (it waits
    // for its slowest op), and without this the tail looks frozen the whole time.
    const tally = { batch: 0, prep: 0, drain: 0, weaken: 0, wait: 0 };
    for (const n of notes) {
      const kind = n.split(' ')[0] as keyof typeof tally;
      if (kind in tally) tally[kind] += 1;
    }
    const usedGb = poolTotal - poolFree(slots);
    ns.print(
      `r${round}: ${tally.batch} batch, ${tally.prep} prep, ${tally.drain} drain, ${tally.weaken} weaken, ${tally.wait} wait` +
        ` | pool ${ns.format.ram(usedGb)}/${ns.format.ram(poolTotal)} (${((100 * usedGb) / Math.max(1, poolTotal)).toFixed(0)}%)`,
    );
    ns.print(`  ${notes.join(' | ')}`);

    const t0 = Date.now();
    await awaitPids(ns, pids);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const earned = ns.getServerMoneyAvailable('home') - homeBefore;
    ns.print(`  r${round} done ${secs}s${earned > 0 ? `, net +$${money$(earned)}` : ''}`);
  }
}
