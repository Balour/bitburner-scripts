import type { NS } from '@ns';
import { crawl } from './lib/net';

/**
 * 2.40 GB. Roots every server whose port requirement we can satisfy.
 *
 * `nuke` checks ONLY `openPortCount >= numOpenPortsRequired` — it never looks at
 * hacking level. So at skill 1 we can root every 0-port server and use its RAM,
 * even the ones we cannot hack. That is ~100 GB against 8 GB of home, for $0.
 *
 * v3: `nuke` and the port openers return `false` on failure instead of throwing.
 * Branch on the return value; never wrap them in try/catch.
 *
 * Idempotent. Re-run after buying or writing a new port opener.
 * Run: `run /root.js`
 */
const OPENERS = [
  { file: 'BruteSSH.exe', crack: (ns: NS, host: string) => ns.brutessh(host) },
  { file: 'FTPCrack.exe', crack: (ns: NS, host: string) => ns.ftpcrack(host) },
  { file: 'relaySMTP.exe', crack: (ns: NS, host: string) => ns.relaysmtp(host) },
  { file: 'HTTPWorm.exe', crack: (ns: NS, host: string) => ns.httpworm(host) },
  { file: 'SQLInject.exe', crack: (ns: NS, host: string) => ns.sqlinject(host) },
];

export async function main(ns: NS) {
  const hosts = crawl(ns);
  const owned = OPENERS.filter((opener) => ns.fileExists(opener.file, 'home'));

  const newly: string[] = [];
  const locked: { host: string; needed: number }[] = [];

  for (const host of hosts) {
    if (host === 'home' || ns.hasRootAccess(host)) continue;

    const needed = ns.getServerNumPortsRequired(host);
    if (needed > owned.length) {
      locked.push({ host, needed });
      continue;
    }
    for (const opener of owned) opener.crack(ns, host);
    if (ns.nuke(host)) newly.push(host);
    else locked.push({ host, needed });
  }

  let pool = 0;
  let count = 0;
  for (const host of hosts) {
    if (host === 'home' || !ns.hasRootAccess(host)) continue;
    pool += ns.getServerMaxRam(host);
    count += 1;
  }

  ns.tprint('');
  ns.tprint('=== root ===');
  ns.tprint(`  openers owned: ${owned.length === 0 ? 'none' : owned.map((o) => o.file).join(', ')}`);
  ns.tprint(`  newly rooted:  ${newly.length === 0 ? 'none' : newly.join(', ')}`);
  ns.tprint(`  rooted total:  ${count} host(s), ${ns.format.ram(pool)} of worker RAM`);

  if (locked.length > 0) {
    const byPorts = new Map<number, number>();
    for (const entry of locked) byPorts.set(entry.needed, (byPorts.get(entry.needed) ?? 0) + 1);
    const summary = [...byPorts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ports, n]) => `${n} need ${ports} port${ports === 1 ? '' : 's'}`)
      .join(', ');
    ns.tprint(`  still locked:  ${locked.length} host(s) — ${summary}`);
  }
  ns.tprint('');
}
