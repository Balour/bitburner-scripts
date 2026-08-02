import type { NS } from '@ns';
import { VERSION, PORT_SING_STATUS, PORT_SING_PAUSE, SING_FILE, ENDGAME_FILE, INSTALL_FILE } from './lib/ports';
import { liveStrategy } from './lib/bitnode';
import { expForSkill } from './lib/skills';
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
 *
 * The ENDGAME PUSH holds installs near the hacking goal so one climb can reach it — but only while that is
 * still believed possible. It samples real hacking XP and projects the arrival time against
 * `expForSkill(hackReq, mult)`; if that exceeds `endgame.pushAbandonMs` the hold is released, because XP is
 * exponential in `level / mult` and a climb that projects long is one that never arrives. Augs are BOUGHT
 * every pass regardless — purchasing only queues, it resets nothing, and rep left unspent is destroyed by
 * the next install anyway.
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
const REV = 'v7';

const LOOP_MS = 1000;
/** Re-check program buys this often, until all six are owned (then stop). */
const PROGRAMS_EVERY_MS = 300_000;
/** Yield the slot to attempt faction-server backdoors this often, as hacking climbs during the grind. */
const BACKDOOR_EVERY_MS = 120_000;
/** Check for (and accept) gang-faction invites this often during the karma grind. */
const JOIN_EVERY_MS = 30_000;
/** How long to accumulate hacking XP before projecting whether the endgame push can finish. This is the
 * LATENCY of the whole mechanism: nothing is decided until one full window has elapsed since entering the
 * push band (or since the last projection — it re-arms each time). 3 minutes is ~18 loop ticks, enough to
 * average out bursty script XP against steady faction-work XP, and small against a `pushAbandonMs` measured
 * in tens of minutes. Note the window restarts when the CONTROLLER does, so a fresh launch always waits it
 * out before it can abandon anything. */
const PUSH_SAMPLE_MS = 180_000;
/** Penalty applied to the post-install climb estimate. The XP rate is measured with a full purchased-server
 * pool and a full bank; an install wipes both, so the first stretch of the re-climb runs slower than the
 * sample predicts. Bias the comparison against resetting, so a marginal call defaults to finishing what we
 * started. Irrelevant when the multiplier gain is large (the usual case) and decisive when it is not. */
const REBOOTSTRAP_TAX = 2;
/** P2/P3 helper cadences. */
const AUGS_EVERY_MS = 120_000;
const REP_EVERY_MS = 120_000;
const HOME_EVERY_MS = 600_000;
/** Actions run focused (faster gym). But the moment YOU take focus, the controller releases the action
 * slot and backs off for this long before resuming — a real window to do whatever, uninterrupted. */
const FOCUS_GRACE_MS = 60_000;
/** City factions are skipped by the controller's own join loop — `cities.js` owns them, because joining
 * one blocks its enemies for the rest of the install cycle, and that decision belongs to `rep.cityBloc`
 * rather than to whichever invite happens to arrive first. (Membership wipes at every install, so the
 * choice is remade each cycle — cheap, but still a choice.) Tian Di Hui is deliberately NOT here: it has
 * no enemies, so accepting it anywhere is free. */
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

/** The endgame close-out record redpill.js/endgame.js maintain (free file read). Validated against a
 * fail-SAFE default — an unreadable/half-written file reads as "no Red Pill, keep building", never as
 * "ready to leave". `redPillInstalled` latches close mode across the Red-Pill install's reset.
 *
 * `nodeReset` keys the record to the node INSTANCE: it's stable across aug installs (so the latch survives
 * the Red-Pill install + relaunch) but changes on entering a BitNode — so a record left by a PRIOR run, even
 * of the same BitNode number (BN4 -> BN4), is discarded as stale instead of falsely reporting the Red Pill in. */
interface Endgame {
  redPillInstalled: boolean;
  /** We have REACHED the daemon hacking req at least once this node instance. redpill.js stamps it true on
   * every write, because close mode is the only thing that runs it — so by then the proof already happened.
   *
   * Why it must be a latch and not a live `hack >= req` read: acquiring the Red Pill needs 2.5M Daedalus rep
   * and $0, and NO hacking level at all — the req exists only for the final w0r1d_d43m0n backdoor. Deriving
   * close mode from live hacking meant any install during the close-out (the favor bank below) dropped us
   * back to BUILD mode, which then re-climbed to the req BEFORE buying the Red Pill — and the Red-Pill
   * install immediately reset that climb to 1. That is one entire wasted climb per close-out. */
  provenReq: boolean;
  phase: string;
  detail: string;
}
function readEndgame(ns: NS, nodeReset: number): Endgame {
  const safe: Endgame = { redPillInstalled: false, provenReq: false, phase: '', detail: '' };
  try {
    const raw = ns.read(ENDGAME_FILE);
    if (!raw) return safe;
    const o = JSON.parse(raw) as Partial<Endgame> & { nodeReset?: number };
    if (o.nodeReset !== nodeReset) return safe; // record is from a previous node instance — ignore it
    return {
      redPillInstalled: o.redPillInstalled === true,
      provenReq: o.provenReq === true,
      phase: typeof o.phase === 'string' ? o.phase : '',
      detail: typeof o.detail === 'string' ? o.detail : '',
    };
  } catch {
    return safe;
  }
}

/** augs.js's record of the queue (free — `ns.read` is 0 GB; the controller must not pay 5 GB for
 * `getOwnedAugmentations` itself). `realQueued` is display only, since install.js recomputes it live rather
 * than resting a destructive decision on a file. `hackMultGain` drives the push decision, and its fail-safe
 * default of 1 means "nothing queued would help" — on which the hold is never released. */
function readAdvice(ns: NS, augReset: number): { realQueued: number; hackMultGain: number } {
  const safe = { realQueued: -1, hackMultGain: 1 };
  try {
    const raw = ns.read(INSTALL_FILE);
    if (!raw) return safe;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o['augReset'] !== augReset) return safe;
    const gain = o['hackMultGain'];
    return {
      realQueued: typeof o['realQueued'] === 'number' ? o['realQueued'] : -1,
      // Guard the direction too: a gain below 1 would make installing look artificially attractive.
      hackMultGain: typeof gain === 'number' && gain >= 1 ? gain : 1,
    };
  } catch {
    return safe;
  }
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
  const strat = liveStrategy(ns, node);

  // Upgrade home FIRST, while it still has room — home.js needs free RAM to run, and once we reserve ours
  // there is none. This is the only reliable window to grow home (buys space for found.js, the gang, and
  // the P2 helpers). No-op if already at cap or we can't afford it. Restarting the controller re-runs this,
  // so home keeps growing as money arrives.
  if (ns.getServerMaxRam('home') < strat.home.ramCap) {
    await waitPid(ns, ns.exec('/singularity/home.js', 'home'));
  }

  // Reserve ROUTE-AWARE RAM. The karma grind needs ~26 GB (commitCrime / getCrimeChance / gymWorkout /
  // travelToCity); everything else needs only ~12 (cheap getters + exec — the heavy aug/rep work runs in
  // one-shot helpers). Reserving lean leaves home free for those helpers, and is why the controller
  // RELAUNCHES itself after founding (see the found branch) — the reservation is monotonic and a P1-sized
  // one would otherwise starve them for the rest of the run.
  //
  // KEYED ON THE ROUTE, not on `inGang`, and that distinction is the whole point. On the hacking route
  // `crimeStep` is never called, so the 26 GB would be reserved and never used — and on a 32 GB home that
  // leaves ~2 GB, which is less than `augs.js` (30 GB) or `repwork.js` (29 GB) need. The old gang-only test
  // would have silently starved every P2 helper in BN1 while looking perfectly healthy.
  const inGangStart = ns.gang.inGang();
  const grinding = strat.route.primary === 'gang' && !inGangStart;
  const NEEDED = grinding ? 26 : 12;
  const target = grinding ? 30 : 16;
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
  // Endgame-push projection state. `pushHopeless` latches the verdict that this climb cannot reach the
  // daemon requirement, releasing the install hold; it is cleared the moment hacking drops back below the
  // push band, which is exactly what the resulting install does.
  let pushSampleMs = -1;
  let pushSampleXp = 0;
  let pushEtaMs = 0;
  let pushHopeless = false;
  /** Set only when the projection PROVED installing arrives sooner than climbing. That verdict is what
   * authorizes install.js to reset on a single aug (`--relaxed`); the plain hold-release does not. */
  let installWins = false;

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
    //
    // The 5-minute cadence is for a POOR run, where the buyer would only be re-printing the same gate lines.
    // Once cash clears `programs.richCash` the openers are affordable on sight and the delay is pure lost
    // pool RAM — `nuke` ignores hacking level, so an opener roots its servers the moment we own it. Compared
    // against LIVE cash every tick, so the post-install window (broke, then rich once the gang refills)
    // switches over as soon as the money is there rather than waiting out a full slow interval.
    const programsEvery =
      ns.getServerMoneyAvailable('home') >= strat.programs.richCash ? strat.programs.richPollMs : PROGRAMS_EVERY_MS;
    if (!allProgramsOwned(ns) && elapsedMs - lastPrograms >= programsEvery) {
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

    // GANG-IF-FREE. On the hacking route nothing chases karma, but crime-money bridging accrues it as a
    // side effect (and sleeves will, once SF-10 exists). If it happens to cross the gate, take the gang:
    // it is income plus a faction that earns rep passively, for zero slot time we would not have spent
    // anyway. `getPlayer` is already paid for below, and `found.js` no-ops without a gang-faction
    // membership, so a failed attempt costs one exec.
    if (!inGang && !strat.crime.needGang && strat.route.gangIfFree) {
      if (ns.getPlayer().karma <= strat.crime.karmaTarget) {
        await waitPid(ns, ns.exec('/gang/found.js', host));
        if (ns.gang.inGang()) {
          ns.exec('/bootstrap.js', 'home');
          publish('gang-free', 'karma crossed the gate on the hacking route — gang founded for free');
        }
      }
    }

    // P1: karma grind -> found the gang. ONLY the action slot is owned here; the aug/install/home helpers
    // below run on their own cadence during the grind, because they need no slot and waiting for the gang
    // to spend $2.7b was the flaw this whole route split exists to fix.
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

      // BUY AND INSTALL DURING THE GRIND. These need no action slot, so blocking them on the gang was
      // pure dead time — measured in BN1 as $2.7b idle against 31 purchasable augs. Combat augs bought
      // here directly speed the grind (homicide success is Σ(weight×stat), STR/DEF weighted 2), and
      // installing resets combat levels but NOT the multipliers, so each cycle re-trains faster.
      //
      // RAM caveat, and it is real: the grind holds ~26 GB, so on a 32 GB home `augs.js` (30 GB) simply
      // will not fit and `reserveOk` declines with "host too full". That is fail-safe, not a failure —
      // home grows, and the pass lands on a later tick. It does mean the gang route only gets this
      // benefit once home clears ~64 GB.
      if (elapsedMs - lastAugs >= AUGS_EVERY_MS) {
        await waitPid(ns, ns.exec('/singularity/augs.js', host));
        await waitPid(ns, ns.exec('/singularity/install.js', host));
        lastAugs = elapsedMs;
      }
      if (elapsedMs - lastHome >= HOME_EVERY_MS) {
        await waitPid(ns, ns.exec('/singularity/home.js', host));
        lastHome = elapsedMs;
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

    // Cash is fine. Read the endgame record (free) — redpill.js/endgame.js maintain it. Fail-safe default.
    const hack = ns.getHackingLevel();
    const eg = readEndgame(ns, info.lastNodeReset);

    // CLOSE MODE: we've PROVEN we can hit the daemon req — hacking reached it (and since we stop installing
    // here it stays reached), OR the Red Pill is already installed (the post-install re-climb). Either way,
    // stop building and drive the exit. Verified chain (live d.ts + bitburner-src): the Red Pill (2.5M
    // Daedalus rep, $0) must be INSTALLED — that's what wires w0r1d_d43m0n into the network — then the daemon
    // is rooted and either backdoored (-> BitVerse, which WAITS for your node choice) or destroyed (auto-jump).
    // `provenReq` is the third term, and it is what stops an install DURING the close-out from bouncing us
    // back to building. See the Endgame interface: the Red Pill costs rep and $0, not hacking level, so once
    // the req has been proven the right order is bank favor -> donate -> buy -> install -> climb ONCE.
    const closeMode = hack >= strat.endgame.hackReq || eg.redPillInstalled || eg.provenReq;
    if (closeMode) {
      // Endgame action already taken: daemon backdoored, sitting at the BitVerse for you to choose a node.
      if (eg.phase === 'bitverse') {
        publish('bitverse', eg.detail || 'w0r1d_d43m0n backdoored — pick your next BitNode in the BitVerse');
        await sleepFor(60_000);
        continue;
      }
      // Fully ready — Red Pill installed AND re-climbed to the daemon req: root + backdoor/destroy the daemon.
      if (eg.redPillInstalled && hack >= strat.endgame.hackReq) {
        await waitPid(ns, ns.exec('/singularity/endgame.js', host));
        // Surface endgame.js's own result (await-ram / await-root / bitverse) so a jam shows its reason.
        const after = readEndgame(ns, info.lastNodeReset);
        publish('endgame', after.detail || `Red Pill in + hacking ${hack} — daemon root + backdoor/destroy`);
        await sleepFor(10_000);
        continue;
      }
      // Otherwise: grind Daedalus rep for the Red Pill, or re-climb hacking after installing it. redpill.js
      // owns this — and crucially does NOT install non-Red-Pill augs, since an install would wipe Daedalus rep.
      await waitPid(ns, ns.exec('/singularity/redpill.js', host));
      publish('P3-endgame', eg.detail || `closing out — hacking ${hack}/${strat.endgame.hackReq}`);
      await sleepFor(10_000);
      continue;
    }

    // P3: bounded home upgrade (doesn't reset hacking, so always fine).
    if (elapsedMs - lastHome >= HOME_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/home.js', host));
      lastHome = elapsedMs;
    }

    // BUILD MODE (pre-proof): bank multipliers. The pushFraction hold stops INSTALLING once hacking is within
    // that fraction of the goal — each install resets hacking to ~1, so holding near the top lets the first
    // climb actually REACH the daemon req and trip close mode above (else it would never get there).
    const nearGoal = hack >= strat.endgame.hackReq * strat.endgame.pushFraction;
    if (!nearGoal) {
      // Back below the push band (i.e. we just installed) — re-arm the projection and the verdict.
      pushHopeless = false;
      installWins = false;
      pushSampleMs = -1;
      pushEtaMs = 0;
    } else if (!pushHopeless) {
      // Is this climb actually going to arrive? Measure rather than assume. XP is exponential in
      // `level / mult`, so a climb that is merely slow here is usually one that never finishes — see
      // lib/skills.ts. Sample over a window, project, and give up if it exceeds `pushAbandonMs`.
      const player = ns.getPlayer() as unknown as { exp: Record<string, number>; mults: Record<string, number> };
      // Bracket access: the static parser bills a bare property name that collides with an NS API, and
      // `hacking` collides with the ns.formulas.hacking namespace. Literal brackets are invisible to it.
      const xp = player.exp['hacking'];
      const mult = player.mults['hacking'];
      if (pushSampleMs < 0) {
        pushSampleMs = elapsedMs;
        pushSampleXp = xp;
      } else if (elapsedMs - pushSampleMs >= PUSH_SAMPLE_MS) {
        const perSec = (xp - pushSampleXp) / ((elapsedMs - pushSampleMs) / 1000);
        pushEtaMs = perSec > 0 ? ((expForSkill(strat.endgame.hackReq, mult) - xp) / perSec) * 1000 : Infinity;

        // THE ACTUAL DECISION: compare the two futures rather than testing a threshold. Finishing this climb
        // needs the remaining XP at the CURRENT multiplier; installing restarts from ~0 XP but at a higher
        // one, and `expForSkill` is exponential in `level / mult`, so a modest multiplier gain can undercut a
        // nearly-complete climb by orders of magnitude. Whichever is sooner wins.
        //
        // This is self-guarding, which is why it replaces the count thresholds: with no hacking multiplier
        // queued, `gain` is 1, so the post-install estimate starts from zero XP at the same multiplier and is
        // necessarily WORSE than continuing. A useless aug therefore can never trigger a reset.
        const gain = readAdvice(ns, info.lastAugReset).hackMultGain;
        const etaAfterMs =
          perSec > 0 ? (expForSkill(strat.endgame.hackReq, mult * gain) / perSec) * 1000 * REBOOTSTRAP_TAX : Infinity;

        if (gain > 1 && etaAfterMs < pushEtaMs) {
          pushHopeless = true;
          installWins = true;
          publish(
            'P2-push-install',
            `installing beats climbing — ${ns.format.time(etaAfterMs)} at mult ${(mult * gain).toFixed(2)} vs ` +
              `${ns.format.time(pushEtaMs)} at ${mult.toFixed(2)}; queued augs give x${gain.toFixed(2)} hacking`,
          );
        } else if (pushEtaMs > strat.endgame.pushAbandonMs) {
          // Backstop: the climb is going nowhere but nothing queued would fix it. Release the hold anyway so
          // the normal install triggers (count / stalled / favor) can run and augs keep accumulating.
          pushHopeless = true;
          publish(
            'P2-push-abandon',
            `projected ${ns.format.time(pushEtaMs)} to reach ${strat.endgame.hackReq} at hacking mult ` +
              `${mult.toFixed(2)}, and nothing queued improves it — releasing the install hold`,
          );
        }
        pushSampleMs = elapsedMs; // re-arm the window either way
        pushSampleXp = xp;
      }
    }

    // Hold installs only while a push is still believed winnable.
    const pushing = nearGoal && !pushHopeless;

    // BUY every pass, INSTALL only outside the push. Purchasing queues an aug; it resets nothing — only
    // install.js does. Skipping augs.js during the push was strictly a loss: repwork.js below keeps earning
    // faction rep throughout, and rep is wiped by the next install, so any rep earned and not spent on the
    // augs it unlocked is thrown away. Now it is banked as queued augs instead, ready for that install.
    if (elapsedMs - lastAugs >= AUGS_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/augs.js', host));
      // `--relaxed` after an abandon: holding out for a big batch only pays while the run is still making
      // progress, and we have just measured that it isn't. See install.ts.
      if (!pushing) {
        // `--relaxed` ONLY on a proven verdict: the projection showed installing reaches the goal sooner.
        // A bare hold-release (the backstop) leaves the normal count/stalled/favor triggers in charge.
        const args = installWins ? ['--relaxed'] : [];
        await waitPid(ns, ns.exec('/singularity/install.js', host, 1, ...args));
      }
      lastAugs = elapsedMs;
    }

    // LOCATION factions — Tian Di Hui and (if configured) a city bloc. Cheap and slow-changing, so it
    // rides the rep cadence rather than getting a timer of its own; cities.js no-ops once everything is
    // held, and self-gates on affording the join, so a poor run just skips it.
    //
    // Worth the exec even on a mature run: these invites are the only ones that cannot be earned by
    // grinding, only by BEING somewhere with money. TDH's S.N.A. is a rank-#9 rep-booster for 6.25k rep,
    // which is close to the cheapest compounding aug in the game — it was sitting behind a plane ticket.
    if (elapsedMs - lastRep >= REP_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/cities.js', host));
    }

    // Earn reputation toward target augs (hacking-track work also raises hacking level toward the endgame).
    if (elapsedMs - lastRep >= REP_EVERY_MS) {
      await waitPid(ns, ns.exec('/singularity/repwork.js', host));
      lastRep = elapsedMs;
    }
    // Surface the PROJECTION, not just the level. A rising number that will never arrive reads as progress;
    // "ETA 53 hours" reads as the dead end it is.
    const eta = Number.isFinite(pushEtaMs) ? ns.format.time(pushEtaMs) : 'never at this rate';
    // Show the QUEUE, not just the hacking level. "Why isn't it installing?" is answered by a count against
    // its threshold, and augs.js already publishes that count — reading it here is free.
    const adv = readAdvice(ns, info.lastAugReset);
    const need = installWins ? 1 : strat.install.minAugsQueued;
    publish(
      pushing ? 'P2-push' : 'P2-rep',
      `hacking ${hack}/${strat.endgame.hackReq} · augs ${adv.realQueued}/${need} (x${adv.hackMultGain.toFixed(2)})` +
        (pushing
          ? ` — endgame push: holding installs, climbing${pushSampleMs >= 0 && pushEtaMs > 0 ? ` (ETA ${eta})` : ''}`
          : pushHopeless
            ? ' · push abandoned — banking multipliers to re-climb'
            : ' · buying augs + earning rep'),
    );
    await sleepFor(10_000);
  }
}
