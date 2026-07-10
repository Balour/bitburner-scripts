import type { NS } from '@ns';

/**
 * Imported helper that calls a costed API, used only by `imported.ts` to test
 * whether the static parser follows imports. Nothing else may import this file,
 * or it will inherit the 2 GB `getServer` cost.
 */
export function peekHostname(ns: NS, host: string): string {
  return ns.getServer(host).hostname;
}
