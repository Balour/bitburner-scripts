import type { NS } from '@ns';

/**
 * Network walk. Costs any importer 0.25 GB — `scan` 0.2 + `hasRootAccess` 0.05 —
 * because the static parser follows imports and harvests every identifier in the
 * module, used or not.
 *
 * NEVER import this into a worker. That would be 0.25 GB *per thread*.
 */

/** Breadth-first walk of the whole network from `home`. Includes `home`. */
export function crawl(ns: NS): string[] {
  const seen = new Set<string>(['home']);
  const pending = ['home'];
  const order: string[] = [];

  while (pending.length > 0) {
    const host = pending.shift() as string;
    order.push(host);
    for (const neighbour of ns.scan(host)) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        pending.push(neighbour);
      }
    }
  }
  return order;
}

/** The subset we have admin rights on. These are the only hosts that can run scripts. */
export function rooted(ns: NS, hosts: string[]): string[] {
  return hosts.filter((host) => ns.hasRootAccess(host));
}

/**
 * BFS from `from` (default `home`) to `target`, returning the hop path INCLUDING
 * both endpoints (`[from, ..., target]`), or `null` if `target` is unreachable.
 *
 * Imported alone this costs 0.2 GB (only `ns.scan`) — the parser follows imports
 * per symbol, so it does NOT drag in `rooted`'s `hasRootAccess`.
 */
export function pathTo(ns: NS, target: string, from = 'home'): string[] | null {
  const seen = new Set<string>([from]);
  const pending = [from];
  const parent = new Map<string, string | null>([[from, null]]);

  while (pending.length > 0) {
    const host = pending.shift() as string;
    if (host === target) {
      const route: string[] = [];
      for (let h: string | null = target; h !== null; h = parent.get(h) ?? null) route.unshift(h);
      return route;
    }
    for (const neighbour of ns.scan(host)) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        parent.set(neighbour, host);
        pending.push(neighbour);
      }
    }
  }
  return null;
}
