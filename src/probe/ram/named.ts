import type { NS } from '@ns';
import { cheap } from './named-lib';

/**
 * Imports ONLY the free export from a module that also exports a 2 GB
 * `ns.getServer` caller.
 *
 * Expect 1.60 GB. `RamCalculations.ts` maps each `ImportSpecifier` to
 * `module.name` and walks only that symbol's dependencies. A namespace import
 * (`import * as lib`) or a default import instead adds `module.*` and would drag
 * in `costly`, paying the full 3.60 GB.
 *
 * Contrast `imported.ts`, which imports the costly symbol and pays 3.60.
 */
export async function main(ns: NS) {
  ns.tprint(`named: cheap(1) = ${cheap(1)}, ramOverride() reports ${ns.ramOverride()} GB`);
}
