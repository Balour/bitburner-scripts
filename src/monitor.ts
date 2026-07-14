import type { NS } from '@ns';
import type { Target } from './lib/types';
import { crawl, rooted } from './lib/net';
import { TARGETS_FILE, VERSION } from './lib/ports';

/**
 * 2.40 GB. Read-only dashboard. Fits beside daemon.js once home is 16 GB
 * (4.40 + 2.40 = 6.80); at 8 GB, run it instead of the daemon, not with it.
 *
 * v3: `ns.formatNumber` is gone (use `ns.format.*`, 0 GB).
 *
 * Does not open its own tail — tail it on demand from Active Scripts.
 *
 * Run: `run /monitor.js`
 */
export async function main(ns: NS) {
  ns.disableLog('ALL');

  while (true) {
    ns.clearLog();

    const raw = ns.read(TARGETS_FILE);
    const targets: Target[] = raw ? (JSON.parse(raw) as Target[]) : [];
    const hosts = rooted(ns, crawl(ns)).filter((host) => host !== 'home');

    let capacity = 0;
    let used = 0;
    for (const host of hosts) {
      capacity += ns.getServerMaxRam(host);
      used += ns.getServerUsedRam(host);
    }

    ns.print(`monitor ${VERSION}  hacking ${ns.getHackingLevel()}`);
    ns.print(`pool    ${ns.format.ram(used)} / ${ns.format.ram(capacity)} across ${hosts.length} host(s)`);
    ns.print('');

    const byMoney = targets.filter((t) => t.moneyScore > 0).sort((a, b) => b.moneyScore - a.moneyScore);
    if (byMoney.length === 0) {
      ns.print('no hackable target yet — prep/XP phase');
    }

    for (const row of byMoney.slice(0, 5)) {
      const minSec = ns.getServerMinSecurityLevel(row.host);
      const curSec = ns.getServerSecurityLevel(row.host);
      const maxMoney = ns.getServerMaxMoney(row.host);
      const money = ns.getServerMoneyAvailable(row.host);
      const prepped = curSec <= minSec + 0.5 && money >= maxMoney * 0.99 ? 'READY' : '     ';

      ns.print(
        `${prepped} ${row.host.padEnd(18)} ` +
          `sec ${curSec.toFixed(1)}/${minSec.toFixed(1)}  ` +
          `$ ${ns.format.percent(maxMoney > 0 ? money / maxMoney : 0, 0).padStart(4)} of ${ns.format.number(maxMoney)}  ` +
          `${ns.format.number(row.moneyScore)}/sec/thr`,
      );
    }

    await ns.sleep(1000);
  }
}
