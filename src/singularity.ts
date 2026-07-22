import type { NS } from '@ns';
import { VERSION, PORT_SING_STATUS, PORT_SING_PAUSE, SING_FILE } from './lib/ports';
import { strategyFor } from './lib/strategy';
import { sing, reserve, isBackdoored } from './singularity/api';
import { crimeStep } from './singularity/crime';

/**
 * The Singularity controller: the single owner of the player action slot. A persistent state machine
 * that drives the config's per-BitNode plan (`lib/strategy.ts`). The gang and daemon run in parallel —
 * they do NOT use the action slot — so this coexists with them.
 *
 * Phases (gated on live state, so it's robust whether the run is fresh or mid-progress):
 *   P0  keep buying TOR + port openers + Formulas as cash allows (instant, no slot) — programs.js
 *   P1  crime -> gym -> homicide grind to the karma target, then found the gang (crime.ts + found.js)
 *   P2  join factions, buy augs (augs.js), earn rep (repwork.js), install + relaunch (install.js)
 *   P3  bounded home upgrade (home.js); at the hacking gate, notify (default) or destroy (endgame.js)
 * Backdoor faction servers throughout, as hacking climbs (backdoor.js).
 *
 * It honors PORT_SING_PAUSE (write '1' to yield the slot for manual play) and publishes a timestamped
 * progress record to PORT_SING_STATUS + SING_FILE so an unattended run is debuggable.
 *
 * RAM: reserves ~26 GB for the bracket-hidden Singularity calls (×1 inside BN4). launch.js places it on
 * HOME (never a pool host — the daemon fills pool RAM with workers and would starve it); in BN4,
 * monitor/share/auto-buy are BN_DISABLE'd so it fits a 32 GB home next to the daemon. The heavy P2/P3 work
 * runs in exec'd one-shot helpers. P2/P3 are UNVERIFIED, and founding the gang wants an upgraded home
 * (~64 GB) so the gang + P2 helpers fit — validate in-game.
 *
 * Run it via `run /bootstrap.js` (which runs launch.js), or `run /singularity/launch.js` directly.
 */
const REV = 'v1';

const LOOP_MS = 1000;
/** Re-check program buys this often, until all six are owned (then stop). */
const PROGRAMS_EVERY_MS = 300_000;
/** Yield the slot to attempt faction-server backdoors this often, as hacking climbs during the grind. */
const BACKDOOR_EVERY_MS = 120_000;
/** Check for (and accept) gang-faction invites this often during the karma grind. */
const JOIN_EVERY_MS = 30_000;
/** P2/P3 helper cadences. */
const AUGS_EVERY_MS = 120_000;
const REP_EVERY_MS = 120_000;
const HOME_EVERY_MS = 600_000;
/** Actions run focused (faster gym). But the moment YOU take focus, the controller releases the action
 * slot and backs off for this long before resuming — a real window to do whatever, uninterrupted. */
const FOCUS_GRACE_MS = 60_000;
/** Mutually-exclusive city factions — join at most one, so P2 skips auto-joining them to avoid a lockout. */
const CITY_FACTIONS = new Set(['Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'Ishima', 'New Tokyo']);
/** Below this cash in P2, run the action slot on crime-for-money instead of rep-work — bridges the early
 * gang ramp and post-aug-install drought. Above it, the gang provides and the slot does rep-work. */
const CRIME_MONEY_FLOOR = 10e6;
/** The programs P0 wants owned before it stops re-checking. */
const PROGRAMS = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe', 'Formulas.exe'];

async function waitPid(ns: NS, pid: number) {
  if (pid === 0) return;
  while (ns.isRunning(pid)) await ns.sleep(200);
}

const allProgramsOwned = (ns: NS) => PROGRAMS.every((p) => ns.fileExists(p, 'home'));

/** The backdoor-gated faction servers. */
const FACTION_SERVERS = ['CSEC', 'avmnite-02h', 'I.I.I.I', 'run4theh111z', 'fulcrumassets'];

/** True only if some faction server is rooted, level-eligible, and NOT yet backdoored — i.e. a pass would
 * actually DO something. Gating the pass on this means a run where they're all done (or all still level-
 * gated) never fires backdoor.js, so it never interrupts the action slot for nothing. */
function backdoorPending(ns: NS): boolean {
  const level = ns.getHackingLevel();
  return FACTION_SERVERS.some(
    (h) => ns.hasRootAccess(h) && level >= ns.getServerRequiredHackingLevel(h) && !isBackdoored(ns, h),
  );
}

export async function main(ns: NS) {
  ns.disableLog('ALL');

  const info = ns.getResetInfo();
  const node = info.currentNode;
  const hasSf4 = (info.ownedSF.get(4) ?? 0) > 0 || node === 4;
  if (!hasSf4) {
    ns.tprint('singularity: no SF-4 and not in BN4 — the Singularity API is unavailable. Nothing to do.');
    return;
  }
  const strat = strategyFor(node);

  // Upgrade home FIRST, while it still has room — home.js needs free RAM to run, and once we reserve ours
  // there is none. This is the only reliable window to grow home (buys space for found.js, the gang, and
  // the P2 helpers). No-op if already at cap or we can't afford it. Restarting the controller re-runs this,
  // so home keeps growing as money arrives.
  if (ns.getServerMaxRam('home') < strat.home.ramCap) {
    await waitPid(ns, ns.exec('/singularity/home.js', 'home'));
  }

  // Reserve PHASE-AWARE RAM. P1 needs ~26 GB (crime calls); P2 only ~12 (cheap getters + exec — the heavy
  // aug/rep work runs in one-shot helpers). Reserving lean in P2 leaves home free for those helpers, and is
  // why the controller RELAUNCHES itself after founding (see the found branch) — a P1-sized reservation is
  // monotonic and would otherwise starve them. On a shared home the daemon's transient rank/root execs
  // briefly occupy RAM, so retry until we get enough (they finish in seconds) or give up if home is full.
  const inGangStart = ns.gang.inGang();
  const NEEDED = inGangStart ? 12 : 26;
  const target = inGangStart ? 16 : 30;
  let alloc = reserve(ns, target);
  for (let i = 0; alloc < NEEDED && i < 30; i++) {
    await ns.sleep(2000);
    alloc = reserve(ns, target);
  }
  if (alloc < NEEDED) {
    ns.tprint(
      `singularity: could only reserve ${alloc.toFixed(1)} GB (need ${NEEDED}). Home is too full — ` +
        `upgrade home or free RAM, then relaunch.`,
    );
    return;
  }

  const s = sing(ns);
  const host = ns.getHostname();
  ns.print(`singularity ${REV} [build ${VERSION}] — BN${node}`);

  let elapsedMs = 0;
  let lastPrograms = -Infinity;
  let lastBackdoor = -Infinity;
  let lastJoin = -Infinity;
  let lastAugs = -Infinity;
  let lastRep = -Infinity;
  let lastHome = -Infinity;
  // When the player takes focus mid-action, we back off (release the slot, idle) until this time.
  let focusYieldUntil = -Infinity;

  const publish = (phase: string, detail: string, extra: Record<string, unknown> = {}) => {
    const json = JSON.stringify({ rev: REV, build: VERSION, node, phase, detail, elapsedMs, ...extra });
    ns.clearPort(PORT_SING_STATUS);
    ns.writePort(PORT_SING_STATUS, json);
    ns.write(SING_FILE, json, 'w');
    ns.print(`[${phase} ${ns.format.time(elapsedMs)}] ${detail}`);
  };

  const sleepFor = async (ms: number) => {
    await ns.sleep(ms);
    elapsedMs += ms;
  };

  while (true) {
    // Manual-play opt-out: yield the slot and idle. Accept '1' or 1 (string or number written to the port).
    const pauseFlag = ns.peek(PORT_SING_PAUSE);
    if (pauseFlag === '1' || pauseFlag === 1) {
      s['stopAction']();
      publish('paused', 'PORT_SING_PAUSE=1 — yielding the action slot for manual play');
      await sleepFor(LOOP_MS);
      continue;
    }

    // Focus grace: you took focus mid-action, so we released the slot — stay idle until the window passes.
    if (elapsedMs < focusYieldUntil) {
      const left = Math.ceil((focusYieldUntil - elapsedMs) / 1000);
      publish('focus-yield', `you took focus — backing off ${left}s so you can act`);
      await sleepFor(LOOP_MS);
      continue;
    }

    // P0: buy programs as cash allows (instant, no action slot). Stops once all six are owned.
    if (!allProgramsOwned(ns) && elapsedMs - lastPrograms >= PROGRAMS_EVERY_MS) {
      ns.exec('/singularity/programs.js', host);
      lastPrograms = elapsedMs;
    }

    // Backdoor faction servers as hacking climbs — but ONLY when one is actually rooted, eligible, and
    // un-backdoored, so a no-op pass never interrupts the action slot (that was the periodic focus loss).
    // No stopAction: installBackdoor cancels the current action itself, and only when it truly runs.
    if (elapsedMs - lastBackdoor >= BACKDOOR_EVERY_MS) {
      if (backdoorPending(ns)) await waitPid(ns, ns.exec('/singularity/backdoor.js', host));
      lastBackdoor = elapsedMs;
    }

    const inGang = ns.gang.inGang();

    // P1: karma grind -> found the gang.
    if (strat.crime.needGang && !inGang) {
      const p = ns.getPlayer();

      // Accept invites as they arrive (except mutually-exclusive city factions): gang factions so found.js
      // has a membership to createGang with, and hacking factions banked for P2's aug rep later.
      if (elapsedMs - lastJoin >= JOIN_EVERY_MS) {
        for (const inv of s['checkFactionInvitations']()) {
          if (!CITY_FACTIONS.has(inv) && s['joinFaction'](inv)) publish('P1-join', `joined ${inv}`);
        }
        lastJoin = elapsedMs;
      }

      if (p.karma <= strat.crime.karmaTarget) {
        publish('found', `karma ${Math.floor(p.karma)} <= ${strat.crime.karmaTarget} — founding gang`);
        await waitPid(ns, ns.exec('/gang/found.js', host));
        if (ns.gang.inGang()) {
          // Founded. Bring up the gang stack, then relaunch OURSELVES lean: our P1 crime reservation
          // (~30 GB) is monotonic and would starve the P2 aug/rep helpers. relaunch.js waits for us to exit
          // (freeing that RAM), then launches a fresh P2-sized controller (~16 GB).
          ns.exec('/bootstrap.js', 'home');
          ns.exec('/singularity/relaunch.js', 'home');
          publish('found', 'gang founded — relaunching lean for P2');
          return;
        }
        // createGang failed — no gang-faction membership yet. Back off before retrying so we don't spam.
        publish('found-wait', 'createGang failed — no gang-faction membership yet; will retry');
        await sleepFor(30_000);
        continue;
      }

      const step = await crimeStep(ns, s, strat);
      elapsedMs += step.sleptMs;
      // If you took focus mid-crime, crimeStep already released the slot — back off for the grace window.
      if (step.yielded) focusYieldUntil = elapsedMs + FOCUS_GRACE_MS;
      publish('P1-karma', `${step.detail} · karma ${Math.floor(p.karma)}/${strat.crime.karmaTarget}`, {
        karma: Math.floor(p.karma),
        karmaTarget: strat.crime.karmaTarget,
        action: step.action,
      });
      continue;
    }

    // P2/P3: gang up (or node needs no gang). Factions + rep + augs + install; home upgrade; endgame gate.

    // Join anything invited except the mutually-exclusive city factions (avoid locking out a needed one).
    if (elapsedMs - lastJoin >= JOIN_EVERY_MS) {
      for (const inv of s['checkFactionInvitations']()) {
        if (!CITY_FACTIONS.has(inv) && s['joinFaction'](inv)) publish('P2-join', `joined ${inv}`);
      }
      lastJoin = elapsedMs;
    }

    // Action economy, money-gated. While cash is low (early gang ramp / post-install re-bootstrap), run
    // ONLY crime-for-money and skip everything else — the aug/rep/home helpers need money we don't have
    // AND RAM the crime loop is using, so exec'ing them just crashes them. Above the floor, the gang
    // provides: kill the crime loop and run the P2/P3 helpers.
    const crimeMoney = '/singularity/crime-money.js';
    if (ns.getServerMoneyAvailable('home') < CRIME_MONEY_FLOOR) {
      if (!ns.isRunning(crimeMoney, host)) {
        ns.exec(crimeMoney, host);
        publish('P2-crime', 'low on cash — criming for money while the gang ramps');
      }
      await sleepFor(10_000);
      continue;
    }
    if (ns.isRunning(crimeMoney, host)) ns.kill(crimeMoney, host);

    // Cash is fine: run the P2/P3 helpers one-at-a-time (awaited) so they never overlap on home RAM.

    // P3: bounded home upgrade (ends script-RAM pressure).
    if (elapsedMs - lastHome >= HOME_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/home.js', host));
      lastHome = elapsedMs;
    }

    // Buy affordable augments, then let install.js decide the DESTRUCTIVE install (it self-checks the
    // config trigger and no-ops until met, so this controller never needs getOwnedAugmentations inline).
    if (elapsedMs - lastAugs >= AUGS_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/augs.js', host));
      await waitPid(ns, ns.exec('/singularity/install.js', host));
      lastAugs = elapsedMs;
    }

    // P3 endgame gate.
    const hack = ns.getHackingLevel();
    if (hack >= strat.endgame.hackReq) {
      if (strat.endgame.autoDestroy) {
        publish(
          'endgame',
          `hacking ${hack} >= ${strat.endgame.hackReq} — destroying w0r1d_d43m0n -> BN${strat.endgame.nextNode}`,
        );
        ns.exec('/singularity/endgame.js', host, strat.endgame.nextNode);
        await sleepFor(15_000);
        continue;
      }
      publish(
        'endgame-ready',
        `hacking ${hack} >= ${strat.endgame.hackReq} — READY to leave (autoDestroy off; run endgame.js when you want)`,
      );
      await sleepFor(60_000);
      continue;
    }

    // Earn reputation toward target augs.
    if (elapsedMs - lastRep >= REP_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/repwork.js', host));
      lastRep = elapsedMs;
    }
    publish('P2-rep', `hacking ${hack}/${strat.endgame.hackReq} · buying augs + earning rep`);
    await sleepFor(10_000);
  }
}
