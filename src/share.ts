import type { NS } from '@ns';
import { crawl, rooted } from './lib/net';
import { HOME_RESERVE, VERSION } from './lib/ports';

/**
 * 3.85 GB. Floods spare pool RAM with share() to boost faction reputation gain
 * while you work. The bonus is `1 + ln(threads)/25` — strongly diminishing, so
 * this is a cheap top-up, never a centerpiece. Run it during faction-work
 * sessions; kill it when pure money-stacking (it steals RAM from hacking).
 *
 * Leaves SHARE_MARGIN of the pool free so the daemon's giant grow still fits.
 * Workers are one-shot (~10s), re-launched each cycle, so share yields to hacking
 * within ~10s rather than holding RAM indefinitely.
 *
 *   run /share.js                 use up to 60% of spare pool
 *   run /share.js --cap 0.3       use up to 30%
 */
/** This script's own revision — bump when THIS script's behaviour changes. */
const REV = 'v1';

const WORKER = '/workers/share.js';
const SHARE_COST = 4.0;
const CYCLE_MS = 10500; // just over ShareBonusTime so workers exit before relaunch

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.print(`share ${REV} [build ${VERSION}] starting`);
  const flags = ns.flags([['cap', 0.6]]);
  const cap = Number(flags.cap);
  const copied = new Set<string>();

  while (true) {
    // home included — its idle RAM (512 GB, minus the controller reserve) is fair
    // game for share, same as any pool host. getServerUsedRam already counts the
    // daemon's workers, so this only ever claims genuinely-free RAM.
    const hosts = rooted(ns, crawl(ns));
    let free = 0;
    const slots = hosts
      .map((host) => {
        const reserve = host === 'home' ? HOME_RESERVE : 0;
        const room = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve;
        free += Math.max(0, room);
        return { host, room };
      })
      .sort((a, b) => b.room - a.room);

    // Only claim a capped slice of what is free right now, so the daemon keeps
    // priority for hacking. `free` already excludes RAM the daemon is using.
    let want = Math.floor((free * cap) / SHARE_COST);
    let launched = 0;
    for (const slot of slots) {
      if (want <= 0) break;
      const n = Math.min(Math.floor(slot.room / SHARE_COST), want);
      if (n <= 0) continue;
      if (!copied.has(slot.host)) {
        ns.scp(WORKER, slot.host);
        copied.add(slot.host);
      }
      if (ns.exec(WORKER, slot.host, n) !== 0) {
        launched += n;
        want -= n;
      }
    }

    ns.print(`sharing ${launched} threads (bonus x${(1 + Math.log(Math.max(1, launched)) / 25).toFixed(3)})`);
    await ns.sleep(CYCLE_MS);
  }
}
