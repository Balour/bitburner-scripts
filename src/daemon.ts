import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { HACK_FRACTION, HOME_RESERVE, PORT_RANK, TARGETS_FILE, VERSION } from './lib/ports';

/**
 * ~5.0 GB. Decoupled batcher: every target runs on its OWN clock.
 *
 * The old design dispatched every server, waited for ALL of them, then repeated —
 * so one reqSkill-150 server with a 5-minute weaken paced the whole loop and a
 * 90-second server only got to act every 5 minutes. This version never waits on
 * the whole fleet. Each tick (~1s) it re-dispatches only the targets whose
 * previous batch has finished (polled via isRunning), pulling from whatever pool
 * RAM is free right now, best-value first. Fast servers cycle fast, slow servers
 * cycle slow, all concurrently — income becomes the SUM of each server's own rate.
 *
 * Per target, when it comes free: weaken to min, then PREP (grow to max, no hack),
 * then MAINTAIN (hack a slice + grow it back). Grow-bound piles DRAIN (hack-only).
 *
 * RAM-adaptive for resets: rank runs on home when it fits, else on a remote pool
 * host, so this works at 8 GB home (fresh BitNode) exactly as at 512 GB. Never
 * imports rank — its analysis calls would add 3 GB; batch maths arrive as data.
 *
 * Run: `run /daemon.js`
 */

const HACK_FILE = '/workers/hack.js';
const GROW_FILE = '/workers/grow.js';
const WEAKEN_FILE = '/workers/weaken.js';
const RANK_FILE = '/rank.js';
const ROOT_FILE = '/root.js';

const HACK_COST = 1.7;
const GROW_COST = 1.75;
const WEAKEN_COST = 1.75;
/** rank.js static RAM — used to decide whether home can host it. */
const RANK_RAM = 5.45;

const HACK_SEC = 0.002;
const GROW_SEC = 0.004;
const WEAKEN_SEC = 0.05;

const SEC_SLACK = 0.5;
const DRAIN_FLOOR = 0.03;
/** Skip draining a server whose one hack would take longer than this (ms) — a slow
 * op is fine now (it only ties up its own batch, not the fleet) but a grow-bound
 * pile that slow is rarely worth the threads. */
const MAX_OP_MS = 120000;
const SUSTAIN_SHARE = 0.9;
const PREP_DONE = 0.9;
const TICK_MS = 1000;
/** Ticks between income summaries (~15s). */
const LOG_EVERY = 15;
/** Ticks between a re-root + re-rank (~5 min), on top of level breakpoints. Catches
 * a newly-bought port opener (e.g. SQLInject roots the 5-port servers) or purchased
 * servers without waiting for the next breakpoint or a restart. */
const RERANK_EVERY = 300;

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

interface Job {
  pids: number[];
  phase: string;
}

function poolOf(ns: NS, hosts: string[]): Slot[] {
  const slots: Slot[] = [];
  for (const host of hosts) {
    const capacity = ns.getServerMaxRam(host);
    if (capacity <= 0) continue;
    // home is a worker host too, but keep HOME_RESERVE for the controllers + rank.
    let free = capacity - ns.getServerUsedRam(host);
    if (host === 'home') free -= HOME_RESERVE;
    if (free >= HACK_COST) slots.push({ host, free });
  }
  return slots.sort((a, b) => b.free - a.free);
}

function poolFree(slots: Slot[]): number {
  return slots.reduce((sum, slot) => sum + Math.max(0, slot.free), 0);
}

/** Spread `want` threads across hosts, largest free first. Mutates slots. */
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

function alive(ns: NS, pids: number[]): boolean {
  return pids.some((pid) => ns.isRunning(pid));
}

async function awaitPids(ns: NS, pids: number[]) {
  if (pids.length === 0) return;
  while (alive(ns, pids)) await ns.sleep(200);
}

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

/** Home if it can host rank.js, else the biggest remote pool host that can. */
function pickRankHost(ns: NS, hosts: string[]): string {
  if (ns.getServerMaxRam('home') - ns.getServerUsedRam('home') >= RANK_RAM + 1) return 'home';
  return (
    hosts
      .filter((h) => h !== 'home' && ns.getServerMaxRam(h) - ns.getServerUsedRam(h) >= RANK_RAM + 1)
      .sort((a, b) => ns.getServerMaxRam(b) - ns.getServerMaxRam(a))[0] ?? ''
  );
}

async function reRank(ns: NS, hosts: string[], copied: Set<string>): Promise<Target[] | null> {
  const rankHost = pickRankHost(ns, hosts);
  if (rankHost === '') {
    ns.print(`  rank: no host with ${RANK_RAM} GB free (home too small, pool empty?)`);
    return null;
  }
  if (rankHost !== 'home') {
    for (const file of [RANK_FILE, '/lib/net.js', '/lib/ports.js']) {
      const key = `${rankHost}|${file}`;
      if (!copied.has(key)) {
        ns.scp(file, rankHost);
        copied.add(key);
      }
    }
  }
  ns.clearPort(PORT_RANK);
  const pid = ns.exec(RANK_FILE, rankHost, 1);
  if (pid === 0) return null;
  await awaitPids(ns, [pid]);

  const raw = ns.readPort(PORT_RANK);
  if (typeof raw !== 'string' || raw === 'NULL PORT DATA') {
    ns.print(`  rank: no data on port (rank.js on ${rankHost} failed?)`);
    return null;
  }
  const targets = JSON.parse(raw) as Target[];
  ns.write(TARGETS_FILE, JSON.stringify(targets, null, 2), 'w');
  ns.print(`  rank on ${rankHost}: ${targets.filter((t) => t.moneyScore > 0).length} hackable of ${targets.length}`);
  return targets;
}

/** Decide and dispatch one ready target's next batch. Mutates job + slots. */
function step(
  ns: NS,
  t: Target,
  money: number,
  maxMoney: number,
  sustain: boolean,
  slots: Slot[],
  job: Job,
  copied: Set<string>,
) {
  const host = t.host;
  const b = batchOf(t);

  if (sustain) {
    const sec = ns.getServerSecurityLevel(host);
    if (sec > t.minSec + SEC_SLACK) {
      const want = Math.ceil((sec - t.minSec) / WEAKEN_SEC);
      if (want * WEAKEN_COST > poolFree(slots)) return; // wait for RAM
      job.pids = dispatch(ns, WEAKEN_FILE, WEAKEN_COST, want, host, slots, copied);
      job.phase = 'weaken';
      return;
    }
    if (b.ram > poolFree(slots)) return; // whole batch must fit, else wait
    const prepping = money < maxMoney * PREP_DONE;
    const hackT = prepping ? 0 : b.hackT;
    const weakenT = Math.max(1, Math.ceil((hackT * HACK_SEC + b.growT * GROW_SEC) / WEAKEN_SEC));
    const pids = hackT > 0 ? dispatch(ns, HACK_FILE, HACK_COST, hackT, host, slots, copied) : [];
    pids.push(...dispatch(ns, GROW_FILE, GROW_COST, b.growT, host, slots, copied));
    pids.push(...dispatch(ns, WEAKEN_FILE, WEAKEN_COST, weakenT, host, slots, copied));
    job.pids = pids;
    job.phase = prepping ? 'prep' : 'maintain';
    return;
  }

  // DRAIN — grow-bound pile, hack-only.
  if (money < maxMoney * DRAIN_FLOOR) {
    job.pids = [];
    job.phase = 'drained';
    return;
  }
  if (ns.getHackTime(host) > MAX_OP_MS) {
    job.pids = [];
    job.phase = 'slow';
    return;
  }
  if (b.hackT * HACK_COST > poolFree(slots)) return;
  job.pids = dispatch(ns, HACK_FILE, HACK_COST, b.hackT, host, slots, copied);
  job.phase = 'drain';
}

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.print(`daemon ${VERSION} starting (decoupled)`);

  // Clear stale pool workers from a previous run. Never home (controllers).
  for (const host of rooted(ns, crawl(ns))) {
    if (host !== 'home') ns.killall(host);
  }

  const copied = new Set<string>();
  const jobs = new Map<string, Job>();
  let targets: Target[] = [];
  let lastLevel = 0;
  let tick = 0;
  let anchorMoney = ns.getServerMoneyAvailable('home');

  while (true) {
    tick += 1;
    const level = ns.getHackingLevel();
    const hosts = rooted(ns, crawl(ns));

    if (targets.length === 0 || crossedBreakpoint(lastLevel, level) || tick % RERANK_EVERY === 0) {
      const rootPid = ns.exec(ROOT_FILE, 'home');
      if (rootPid !== 0) await awaitPids(ns, [rootPid]);
      ns.print(`re-rank at level ${level} (was ${lastLevel})`);
      const fresh = await reRank(ns, hosts, copied);
      if (fresh) targets = fresh;
      lastLevel = level;
      if (targets.length === 0) {
        await ns.sleep(2000);
        continue;
      }
    }

    const slots = poolOf(ns, hosts);
    const fitBudget = poolFree(slots) * SUSTAIN_SHARE;

    // Only targets whose previous batch has finished are ready to re-dispatch.
    const ready = targets
      .filter((t) => t.moneyScore > 0)
      .filter((t) => !alive(ns, jobs.get(t.host)?.pids ?? []))
      .map((t) => {
        const money = ns.getServerMoneyAvailable(t.host);
        const maxMoney = ns.getServerMaxMoney(t.host);
        const sustain = batchOf(t).ram <= fitBudget;
        const maxed = sustain && money >= maxMoney * PREP_DONE;
        return { t, money, maxMoney, sustain, maxed };
      })
      // Income-producing (maxed) first, then by score — they win scarce RAM.
      .sort((a, b) => (a.maxed !== b.maxed ? Number(b.maxed) - Number(a.maxed) : b.t.moneyScore - a.t.moneyScore));

    for (const r of ready) {
      if (poolFree(slots) < HACK_COST) break;
      const job = jobs.get(r.t.host) ?? { pids: [], phase: 'idle' };
      step(ns, r.t, r.money, r.maxMoney, r.sustain, slots, job, copied);
      jobs.set(r.t.host, job);
    }

    if (tick % LOG_EVERY === 0) {
      const phases = { maintain: 0, prep: 0, weaken: 0, drain: 0, drained: 0, slow: 0 };
      for (const job of jobs.values()) {
        const key = job.phase as keyof typeof phases;
        if (key in phases) phases[key] += 1;
      }
      const now = ns.getServerMoneyAvailable('home');
      const rate = (now - anchorMoney) / (LOG_EVERY * (TICK_MS / 1000));
      anchorMoney = now;
      const poolMax = hosts.reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);
      const poolUsed = Math.max(0, poolMax - poolFree(slots));
      ns.print(
        `t${tick}: ${phases.maintain} maintain, ${phases.prep} prep, ${phases.weaken} weaken, ${phases.drain} drain, ` +
          `${phases.drained + phases.slow} idle | pool ${ns.format.ram(poolUsed)}/${ns.format.ram(poolMax)} | ` +
          `net ${rate >= 0 ? '+' : ''}$${ns.format.number(rate)}/sec`,
      );
    }

    await ns.sleep(TICK_MS);
  }
}
