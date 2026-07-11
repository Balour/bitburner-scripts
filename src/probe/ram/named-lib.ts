import type { NS } from '@ns';

/**
 * Two exports, one costly and one free, so `named.ts` can show that the parser
 * charges a named import per SYMBOL rather than per module.
 *
 * Only `named.ts` may import this.
 */

/** 2.0 GB if its dependency is walked. */
export function costly(ns: NS, host: string): string {
  return ns.getServer(host).hostname;
}

/** Costs nothing. */
export function cheap(value: number): number {
  return value + 1;
}
