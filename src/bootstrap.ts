import type { NS } from '@ns';
import { VERSION } from './lib/ports';
// Named imports are charged PER SYMBOL, and both of these are 0 GB: strategyFor is pure and the bitnode
// readers only touch ns.read. BN_DISABLE is no longer imported directly — strategyFor owns the
// resolution now, so there is one place that decides what a node runs.
import { liveStrategy, readBitNodeRecord } from './lib/bitnode';

/**
 * ~3.0 GB. Run once after any reset. RAM-adaptive: launches only the scripts that
 * fit the current home, in priority order, leaving headroom for rank/root execs.
 *
 * After a fresh BitNode home is 8 GB and only the daemon fits — that alone earns
 * (it targets n00dles, drains piles, all on the ~100 GB of 0-port pool). As you
 * upgrade home RAM, RE-RUN bootstrap and it adds monitor, then auto-buy, then
 * share. Home RAM survives augment installs, so on those you may already have room
 * for the whole stack immediately.
 *
 * share stays a separate 10s loop (share() lasts ~10s; it would lapse inside a
 * daemon round). It only touches idle RAM, so money-first still holds.
 *
 * Run: `run /bootstrap.js`                     launch everything that fits
 *      `run /bootstrap.js --dry`               print the plan, launch nothing
 *      `run /bootstrap.js --no-hacknet`        skip hacknet this run
 *      `run /bootstrap.js --no-gang --dry`     flags combine freely
 *
 * Each stack entry auto-gets TWO flags: --no-<key> to force it off and --<key> to force it on.
 * Full set: --no-gang/--gang, --no-daemon/--daemon, --no-monitor/--monitor, --no-auto-buy/--auto-buy,
 * --no-share/--share, --no-contracts/--contracts, --no-hacknet/--hacknet. Flags are PER-INVOCATION —
 * nothing is persisted. "Enable"
 * is the absence of a flag, unless a per-BitNode default says otherwise (see below).
 *
 * lib/ports BN_DISABLE is a per-BitNode default opt-out table: in a node where a subsystem isn't worth
 * its RAM (e.g. BN4 runs hacknet at ~5%), its key is listed there and bootstrap skips it BY DEFAULT,
 * with no flag needed. The current BitNode comes from ns.getResetInfo().currentNode.
 *
 * Resolution per key: FORCED-ON WINS > (config-off OR --no-<key>). So --<key> re-enables something the
 * config turned off for one run; --no-<key> turns off something otherwise on; both together => on.
 *
 * A flag/config default prevents a LAUNCH; it does not kill a script that is already running. Kill it
 * yourself first if that's what you want.
 *
 * ns.flags is arg@5 with permissive:false, so an UNDECLARED flag (`--no-hacknat`) throws and kills
 * this script rather than being ignored. That's deliberate — a typo'd opt-out that silently did
 * nothing would launch the very thing you meant to suppress.
 */
/** This script's own revision — bump when THIS script's behaviour changes. */
const REV = 'v8';

/** `key` names the --no-<key> flag. It is a string LITERAL, not an identifier, which is what keeps
 * it free: the static RAM parser harvests bare identifiers, so a variable named `share` would bill
 * ns.share's 2.4 GB and `hacknet`/`exec`/`run` likewise. Keep them strings. */
const STACK = [
  { key: 'daemon', file: '/daemon.js', ram: 4.85, why: 'root + rank + decoupled hacking' },
  // A tiny one-shot placer: it puts the RAM-heavy Singularity controller on home-or-a-pool-host and
  // exits, so its own footprint here is small. The controller self-guards on SF-4 (no-op without it);
  // add 'singularity' to BN_DISABLE for a node where you don't want the loop even with SF-4.
  {
    key: 'singularity',
    file: '/singularity/launch.js',
    ram: 2.6,
    why: 'Singularity loop: programs, backdoor, crime->gang->augs',
  },
  { key: 'monitor', file: '/monitor.js', ram: 2.4, why: 'dashboard' },
  { key: 'auto-buy', file: '/auto-buy.js', ram: 6.05, why: 'compound income into pool RAM' },
  { key: 'share', file: '/share.js', ram: 3.85, why: 'reputation from idle RAM' },
  // Low priority: needs only ~3 GB on home to run — it places the 24 GB solver on a pool host at
  // runtime and self-throttles (run.js ERROR-skips) until one is free. Works in every BitNode.
  {
    key: 'contracts',
    file: '/contracts/loop.js',
    ram: 3.0,
    why: 'periodically auto-solve coding contracts for cash + rep',
  },
  // Lowest priority: self-gates on a cash floor, so it only spends surplus the rest can't use.
  { key: 'hacknet', file: '/hacknet.js', ram: 7.2, why: 'mop surplus cash into hacknet (bridge income)' },
];
/** Launched ahead of the rest whenever we have a gang. Where hacking is throttled (BN2 caps
 * ServerMaxMoney at 0.08) the gang is the economy, not a side-channel — it out-earns the daemon
 * and is the only source of faction rep, so it gets first claim on home RAM.
 *
 * It reserves ~13 GB and execs helpers up to ~12.7 GB on top, hence the fatter headroom. */
const GANG = { key: 'gang', file: '/gang.js', ram: 13.1, why: 'gang: money + faction rep (the BN2 economy)' };
const GANG_HEADROOM = 13;
/** Leave this much home RAM free after each launch, so the daemon can still exec
 * root.js (2.4 GB) on home. rank.js runs remotely when home is too small for it,
 * so we do NOT reserve its 5.45 GB here — that would skip the daemon on an 8 GB home. */
const LAUNCH_HEADROOM = 3;

export async function main(ns: NS) {
  // Schema is DERIVED from the tables, so adding a stack entry auto-adds BOTH its --no-<key> and
  // --<key> flags — there is no second list to forget to update. ns.flags is 0 GB; the names are
  // string literals, so neither costs RAM even where a key collides with an NS API (share/hacknet).
  const flags = ns.flags([
    ...[GANG, ...STACK].flatMap(
      (e) =>
        [
          [`no-${e.key}`, false],
          [e.key, false],
        ] as [string, boolean][],
    ),
    ['dry', false],
  ]);
  const dry = flags.dry as boolean;

  // Per-BitNode default opt-outs. getResetInfo is 1 GB — the only RAM this launcher spends beyond the
  // base and the exec it already needs, trivial on a run-once-and-exit home script.
  const bn = ns.getResetInfo().currentNode;

  // Make sure this node's multiplier record exists before resolving the strategy. Entering a BitNode
  // invalidates it (the record is keyed by node), and bootstrap is the one thing guaranteed to run right
  // after that — so this is where it belongs. One 4 GB probe per run, then never again: an `ok: false`
  // record (no SF-5) is still a record, so this does not retry on every reset.
  //
  // Deliberately BEFORE the strategy is resolved and blocking on it: `strategyFor` needs the multipliers
  // to derive `hackReq`, and a stack launched against a stale hackReq would drive the whole close-out
  // off the wrong number.
  if (!readBitNodeRecord(ns, bn)) {
    const pid = ns.exec('/probe/bitnode.js', 'home');
    if (pid === 0) ns.tprint('WARN bootstrap: could not run /probe/bitnode.js — using hardcoded OVERRIDES.');
    else while (ns.isRunning(pid)) await ns.sleep(200);
  }
  // undefined here is FINE and expected on a run without SF-5: strategyFor falls back to OVERRIDES.
  const strat = liveStrategy(ns, bn);
  const defaultOff = new Set<string>(strat.disabledSubsystems);

  ns.tprint('');
  ns.tprint(
    `=== bootstrap ${REV} [build ${VERSION}] — BN${bn}, default-off: ${defaultOff.size ? [...defaultOff].join(', ') : 'none'}` +
      `${dry ? ' — DRY RUN, launching nothing' : ''} ===`,
  );
  const homeMax = ns.getServerMaxRam('home');

  // `inGang` is 0 GB, so this check is free even on a fresh 8 GB home in a gangless BitNode.
  const stack = ns.gang.inGang() ? [GANG, ...STACK] : STACK;

  // A dry run launches nothing, so getServerUsedRam would never move and every entry would look
  // like it fits. Track the tally ourselves and charge each would-launch against it.
  let simUsed = ns.getServerUsedRam('home');
  // Drives the closing line. The upgrade-your-home advice is only true if RAM actually turned
  // something away — printing it unconditionally reads as a RAM complaint on a home that fits the
  // whole stack, which is exactly backwards.
  let ramSkipped = false;
  let disabledCount = 0;

  for (const { key, file, ram, why } of stack) {
    const headroom = file === GANG.file ? GANG_HEADROOM : LAUNCH_HEADROOM;
    // isRunning first: if it's up, say so. Claiming "disabled" about a live script would be a lie,
    // since --no-<key> only suppresses launching.
    if (ns.isRunning(file, 'home')) {
      ns.tprint(`  running:  ${file}`);
      continue;
    }
    // Force-on wins over both an explicit --no-<key> and a per-BitNode config default.
    const forcedOn = flags[key] as boolean;
    const off = !forcedOn && ((flags[`no-${key}`] as boolean) || defaultOff.has(key));
    if (off) {
      disabledCount++;
      const reason = (flags[`no-${key}`] as boolean) ? `--no-${key}` : `BN${bn} default (--${key} to force on)`;
      ns.tprint(`  disabled: ${file.padEnd(14)} — ${reason}`);
      continue;
    }
    const free = homeMax - (dry ? simUsed : ns.getServerUsedRam('home'));
    if (free < ram + headroom) {
      ramSkipped = true;
      ns.tprint(`  skip:     ${file.padEnd(14)} — needs ${ram} GB + headroom, home has ${ns.format.ram(free)} free`);
      continue;
    }
    if (dry) {
      simUsed += ram;
      ns.tprint(`  would launch: ${file.padEnd(14)} — ${why}`);
      continue;
    }
    const pid = ns.exec(file, 'home');
    ns.tprint(pid !== 0 ? `  launched: ${file.padEnd(14)} — ${why}` : `  FAILED:   ${file}`);
  }

  ns.tprint(
    ramSkipped
      ? `  home ${ns.format.ram(homeMax)} — too small for the whole stack; upgrade it and re-run bootstrap`
      : `  home ${ns.format.ram(homeMax)} — fits the whole stack`,
  );
  if (disabledCount > 0) ns.tprint(`  ${disabledCount} disabled this run — pass --<key> to force one on`);
  ns.tprint('');
}
