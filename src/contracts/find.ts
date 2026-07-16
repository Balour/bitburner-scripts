import type { NS } from '@ns';
import { crawl } from '../lib/net';
import { CONTRACTS_FILE } from '../lib/ports';

/**
 * 2.05 GB. Locates every .cct on the network. Reads nothing about them —
 * `getContractType` alone is 5 GB, so identifying them happens in inspect.js,
 * which must run on a 16 GB host.
 *
 * Contracts appear slowly. Run this occasionally, not in a loop.
 *
 * Run: `run /contracts/find.js`
 */
export async function main(ns: NS) {
  const found: { host: string; file: string }[] = [];

  for (const host of crawl(ns)) {
    // ns.ls filters by SUBSTRING, so '.cct' also matches /data/*.cct.json dumps. Real contracts
    // end in exactly '.cct'.
    for (const file of ns.ls(host, '.cct')) if (file.endsWith('.cct')) found.push({ host, file });
  }

  ns.write(CONTRACTS_FILE, JSON.stringify(found, null, 2), 'w');

  ns.tprint('');
  ns.tprint(`=== ${found.length} coding contract(s) ===`);
  for (const entry of found) ns.tprint(`  ${entry.host.padEnd(20)} ${entry.file}`);
  if (found.length > 0) {
    ns.tprint('');
    ns.tprint(`  Identify one:  run /contracts/inspect.js <host> <file>   (needs a 16 GB host)`);
  }
  ns.tprint('');
}
