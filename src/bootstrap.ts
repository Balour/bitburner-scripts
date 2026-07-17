import type { NS } from '@ns';
import { VERSION } from './lib/ports';

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
 * One `--no-<key>` exists per stack entry: --no-gang, --no-daemon, --no-monitor, --no-auto-buy,
 * --no-share, --no-hacknet. Flags are PER-INVOCATION — nothing is persisted. That is the whole
 * point: hold hacknet down early (`--no-hacknet`) while cash funnels to the gang, then just re-run
 * bootstrap plain once we're well off and it starts. "Enable" is the absence of a flag.
 *
 * `--no-<key>` prevents a LAUNCH; it does not kill a script that is already running. Kill it
 * yourself first if that's what you want.
 *
 * ns.flags is arg@5 with permissive:false, so an UNDECLARED flag (`--no-hacknat`) throws and kills
 * this script rather than being ignored. That's deliberate — a typo'd opt-out that silently did
 * nothing would launch the very thing you meant to suppress.
 */
/** This script's own revision — bump when THIS script's behaviour changes. */
const REV = 'v5';

/** `key` names the --no-<key> flag. It is a string LITERAL, not an identifier, which is what keeps
 * it free: the static RAM parser harvests bare identifiers, so a variable named `share` would bill
 * ns.share's 2.4 GB and `hacknet`/`exec`/`run` likewise. Keep them strings. */
const STACK = [
  { key: 'daemon', file: '/daemon.js', ram: 4.85, why: 'root + rank + decoupled hacking' },
  { key: 'monitor', file: '/monitor.js', ram: 2.4, why: 'dashboard' },
  { key: 'auto-buy', file: '/auto-buy.js', ram: 6.05, why: 'compound income into pool RAM' },
  { key: 'share', file: '/share.js', ram: 3.85, why: 'reputation from idle RAM' },
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
  // Schema is DERIVED from the tables, so adding a stack entry auto-adds its --no-<key> flag —
  // there is no second list to forget to update. ns.flags is 0 GB.
  const flags = ns.flags([...[GANG, ...STACK].map((e) => [`no-${e.key}`, false] as [string, boolean]), ['dry', false]]);
  const dry = flags.dry as boolean;

  ns.tprint('');
  ns.tprint(`=== bootstrap ${REV} [build ${VERSION}]${dry ? ' — DRY RUN, launching nothing' : ''} ===`);
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
    if (flags[`no-${key}`] as boolean) {
      disabledCount++;
      ns.tprint(`  disabled: ${file.padEnd(14)} — --no-${key}`);
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
  if (disabledCount > 0) ns.tprint(`  ${disabledCount} disabled this run — re-run without the flag to start them`);
  ns.tprint('');
}
