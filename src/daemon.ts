import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { HACK_FRACTION, HOME_RESERVE, PORT_RAMNEED, PORT_RANK, TARGETS_FILE, VERSION } from './lib/ports';

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
/** Exact-math ranker, used when Formulas.exe is on home; else RANK_FILE. Both emit
 * the same Target[], so only the file choice differs — batch maths are unchanged. */
const RANK_FILE_FORMULAS = '/rank-formulas.js';
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
/** After money targets, XP-farm servers we cannot hack yet (grow grants exp with no
 * level gate) to raise level and unlock the high-reqSkill giants — but stop once
 * pool free drops to this fraction, leaving that RAM for share. Priority is
 * money > xp > rep. Set to 1 to disable XP farming entirely. */
const SHARE_FLOOR = 0.3;
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
  // Exact grow-thread math when Formulas.exe is present, ratio fallback otherwise.
  const rankFile = ns.fileExists('Formulas.exe', 'home') ? RANK_FILE_FORMULAS : RANK_FILE;
  if (rankHost !== 'home') {
    for (const file of [rankFile, '/lib/rank-core.js', '/lib/net.js', '/lib/ports.js']) {
      const key = `${rankHost}|${file}`;
      if (!copied.has(key)) {
        ns.scp(file, rankHost);
        copied.add(key);
      }
    }
  }
  ns.clearPort(PORT_RANK);
  const pid = ns.exec(rankFile, rankHost, 1);
  if (pid === 0) return null;
  await awaitPids(ns, [pid]);

  const raw = ns.readPort(PORT_RANK);
  if (typeof raw !== 'string' || raw === 'NULL PORT DATA') {
    ns.print(`  rank: no data on port (${rankFile} on ${rankHost} failed?)`);
    return null;
  }
  const targets = JSON.parse(raw) as Target[];
  ns.write(TARGETS_FILE, JSON.stringify(targets, null, 2), 'w');
  ns.print(
    `  rank on ${rankHost} via ${rankFile}: ` +
      `${targets.filter((t) => t.moneyScore > 0).length} hackable of ${targets.length}`,
  );
  return targets;
}

/** Decide and dispatch one ready target's next batch. Mutates job + slots. Returns
 * true if it wanted to dispatch but there was not enough pool RAM (money-starved). */
function step(
  ns: NS,
  t: Target,
  money: number,
  maxMoney: number,
  sustain: boolean,
  slots: Slot[],
  job: Job,
  copied: Set<string>,
): boolean {
  const host = t.host;
  const b = batchOf(t);

  if (sustain) {
    const sec = ns.getServerSecurityLevel(host);
    if (sec > t.minSec + SEC_SLACK) {
      const want = Math.ceil((sec - t.minSec) / WEAKEN_SEC);
      if (want * WEAKEN_COST > poolFree(slots)) return true; // RAM-starved
      job.pids = dispatch(ns, WEAKEN_FILE, WEAKEN_COST, want, host, slots, copied);
      job.phase = 'weaken';
      return false;
    }
    if (b.ram > poolFree(slots)) return true; // whole batch must fit
    const prepping = money < maxMoney * PREP_DONE;
    const hackT = prepping ? 0 : b.hackT;
    const weakenT = Math.max(1, Math.ceil((hackT * HACK_SEC + b.growT * GROW_SEC) / WEAKEN_SEC));
    const pids = hackT > 0 ? dispatch(ns, HACK_FILE, HACK_COST, hackT, host, slots, copied) : [];
    pids.push(...dispatch(ns, GROW_FILE, GROW_COST, b.growT, host, slots, copied));
    pids.push(...dispatch(ns, WEAKEN_FILE, WEAKEN_COST, weakenT, host, slots, copied));
    job.pids = pids;
    job.phase = prepping ? 'prep' : 'maintain';
    return false;
  }

  // DRAIN — grow-bound pile, hack-only.
  if (money < maxMoney * DRAIN_FLOOR) {
    job.pids = [];
    job.phase = 'drained';
    return false;
  }
  if (ns.getHackTime(host) > MAX_OP_MS) {
    job.pids = [];
    job.phase = 'slow';
    return false;
  }
  if (b.hackT * HACK_COST > poolFree(slots)) return true;
  job.pids = dispatch(ns, HACK_FILE, HACK_COST, b.hackT, host, slots, copied);
  job.phase = 'drain';
  return false;
}

/**
 * Farm hacking exp on a server we cannot hack yet: weaken to min (fast grow), then
 * spam grow (exp has no level gate) with a matched weaken to hold security. Uses
 * pool RAM only down to `floorGb`, so share keeps its share. No hack — reqSkill is
 * too high — so this is pure exp toward unlocking the server as a money target.
 */
function stepXp(ns: NS, t: Target, slots: Slot[], job: Job, copied: Set<string>, floorGb: number) {
  const host = t.host;
  const budget = poolFree(slots) - floorGb;
  if (budget < GROW_COST) return;

  const sec = ns.getServerSecurityLevel(host);
  if (sec > t.minSec + SEC_SLACK) {
    const want = Math.min(Math.ceil((sec - t.minSec) / WEAKEN_SEC), Math.floor(budget / WEAKEN_COST));
    if (want < 1) return;
    job.pids = dispatch(ns, WEAKEN_FILE, WEAKEN_COST, want, host, slots, copied);
    job.phase = 'xp-w';
    return;
  }
  // Grow rains exp; a matched weaken (~1 per 12 grow, from the security math) holds
  // it at min. perGrow bundles each grow thread's share of that weaken RAM.
  const perGrow = GROW_COST + (GROW_SEC / WEAKEN_SEC) * WEAKEN_COST;
  const growN = Math.max(1, Math.floor(budget / perGrow));
  const weakenN = Math.max(1, Math.ceil((growN * GROW_SEC) / WEAKEN_SEC));
  const pids = dispatch(ns, GROW_FILE, GROW_COST, growN, host, slots, copied);
  pids.push(...dispatch(ns, WEAKEN_FILE, WEAKEN_COST, weakenN, host, slots, copied));
  job.pids = pids;
  job.phase = 'xp';
}

export async function main(ns: NS) {
  ns.disableLog('ALL');
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

    let moneyStarved = false;
    for (const r of ready) {
      if (poolFree(slots) < HACK_COST) {
        moneyStarved = moneyStarved || ready.some((x) => x.sustain);
        break;
      }
      const job = jobs.get(r.t.host) ?? { pids: [], phase: 'idle' };
      if (step(ns, r.t, r.money, r.maxMoney, r.sustain, slots, job, copied)) moneyStarved = true;
      jobs.set(r.t.host, job);
    }
    // Tell auto-buy to grow the pool only for real hacking demand, not XP fill.
    ns.clearPort(PORT_RAMNEED);
    ns.writePort(PORT_RAMNEED, moneyStarved ? '1' : '0');

    // XP pass — with whatever RAM money did not need (down to the share floor),
    // farm exp on the best servers we cannot hack yet, richest xp first. Raising
    // level unlocks the high-reqSkill giants, which re-rank then adds as targets.
    const poolTotal = hosts.reduce((sum, h) => sum + ns.getServerMaxRam(h), 0);
    const floorGb = poolTotal * SHARE_FLOOR;
    if (poolFree(slots) > floorGb) {
      const xpReady = targets
        .filter((t) => t.moneyScore === 0 && t.xpScore > 0)
        .filter((t) => !alive(ns, jobs.get(t.host)?.pids ?? []))
        .sort((a, b) => b.xpScore - a.xpScore);
      for (const t of xpReady) {
        if (poolFree(slots) <= floorGb) break;
        const job = jobs.get(t.host) ?? { pids: [], phase: 'idle' };
        stepXp(ns, t, slots, job, copied, floorGb);
        jobs.set(t.host, job);
      }
    }

    if (tick % LOG_EVERY === 0) {
      const phases = { maintain: 0, prep: 0, weaken: 0, drain: 0, xp: 0, 'xp-w': 0, drained: 0, slow: 0 };
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
        `t${tick}: ${phases.maintain} maintain, ${phases.prep} prep, ${phases.drain} drain, ` +
          `${phases.xp + phases['xp-w']} xp, ${phases.drained + phases.slow} idle | ` +
          `pool ${ns.format.ram(poolUsed)}/${ns.format.ram(poolMax)} | net ${rate >= 0 ? '+' : ''}$${ns.format.number(rate)}/sec`,
      );
    }

    await ns.sleep(TICK_MS);
  }
}
