import type { NS } from '@ns';
import { VERSION } from './lib/ports';

/**
 * ~2.2 GB. Network audit. Walks the WHOLE tree from home via ns.scan (BFS, no
 * depth limit — unlike the terminal's scan-analyze) and reports every server:
 * its depth, whether it is rooted, and if not hackable, exactly why.
 *
 * The point is to prove what the pool is missing and why. `ns.scan(host)` returns
 * all direct neighbours of a host; following them recursively reaches every server
 * at every depth, so if a server is not in the pool it is a rooting or level gate,
 * never a scan that stopped too shallow.
 *
 * Run: `run /map.js`
 */
interface Node {
  host: string;
  depth: number;
}

/** This script's own revision — bump when THIS script's behaviour changes. */
const REV = 'v1';

export async function main(ns: NS) {
  const level = ns.getHackingLevel();

  // BFS with depth. seen guarantees each server is visited once.
  const seen = new Set<string>(['home']);
  const queue: Node[] = [{ host: 'home', depth: 0 }];
  const nodes: Node[] = [];
  while (queue.length) {
    const node = queue.shift() as Node;
    nodes.push(node);
    for (const next of ns.scan(node.host)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ host: next, depth: node.depth + 1 });
      }
    }
  }

  const openersOwned = [
    ['BruteSSH.exe', 1],
    ['FTPCrack.exe', 1],
    ['relaySMTP.exe', 1],
    ['HTTPWorm.exe', 1],
    ['SQLInject.exe', 1],
  ].filter(([f]) => ns.fileExists(String(f), 'home')).length;

  let rooted = 0;
  let purchased = 0;
  let hackable = 0;
  const lockedByPorts = new Map<number, number>();
  const tooHigh: { host: string; req: number; money: number }[] = [];
  let maxDepth = 0;

  for (const { host, depth } of nodes) {
    if (host === 'home') continue;
    maxDepth = Math.max(maxDepth, depth);
    if (host.startsWith('pserv-')) {
      purchased += 1;
      continue;
    }
    const root = ns.hasRootAccess(host);
    const needed = ns.getServerNumPortsRequired(host);
    const req = ns.getServerRequiredHackingLevel(host);
    const money = ns.getServerMaxMoney(host);

    if (!root) {
      if (needed > openersOwned) lockedByPorts.set(needed, (lockedByPorts.get(needed) ?? 0) + 1);
      continue;
    }
    rooted += 1;
    if (money <= 0) continue;
    if (level >= req) hackable += 1;
    else tooHigh.push({ host, req, money });
  }

  const depthCounts = new Map<number, number>();
  for (const { depth } of nodes) depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);

  ns.tprint('');
  ns.tprint(`=== network map ${REV} [build ${VERSION}] (hacking ${level}) ===`);
  ns.tprint(`  found ${nodes.length} servers, max depth ${maxDepth} — crawl reaches every level`);
  ns.tprint(`  ${rooted} rooted (named) + ${purchased} purchased | hackable now: ${hackable}`);
  ns.tprint('');
  ns.tprint(
    `  servers per depth: ${[...depthCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, n]) => `${d}:${n}`)
      .join('  ')}`,
  );

  if (lockedByPorts.size) {
    ns.tprint('');
    ns.tprint(`  LOCKED (need a port opener you lack — you own ${openersOwned}/5):`);
    for (const [ports, n] of [...lockedByPorts.entries()].sort((a, b) => a[0] - b[0])) {
      ns.tprint(`    ${n} server(s) need ${ports} ports`);
    }
  }

  if (tooHigh.length) {
    ns.tprint('');
    ns.tprint(`  ROOTED but reqSkill > ${level} (hackable once level catches up):`);
    for (const t of tooHigh.sort((a, b) => a.req - b.req).slice(0, 15)) {
      ns.tprint(`    ${t.host.padEnd(20)} needs lvl ${String(t.req).padStart(4)}  ($${ns.format.number(t.money)})`);
    }
  }
  ns.tprint('');
}
