import type { NS } from '@ns';

/**
 * 1.60 GB — `getContractTypes()` costs 0 GB.
 *
 * The complete list of puzzles we will eventually need solvers for, obtained
 * without touching a single real contract. Contrast the rest of the namespace,
 * which is brutal: getContract 15 GB, getContractType / getDescription / getData
 * 5 GB each, attempt 10 GB.
 *
 * `createDummyContract` (2 GB) can later generate a test case of any type on
 * home, so solvers can be developed without risking a real contract's attempts.
 *
 * Run: `run /contracts/catalog.js`
 */
export async function main(ns: NS) {
  const kinds = ns.codingcontract.getContractTypes();
  ns.tprint('');
  ns.tprint(`=== ${kinds.length} coding contract types ===`);
  for (const kind of [...kinds].sort()) ns.tprint(`  ${kind}`);
  ns.tprint('');
}
