import type { NS } from '@ns';

/** Baseline: no NS API beyond free ones. Expect exactly the 1.60 GB base cost. */
export async function main(ns: NS) {
  ns.tprint(`base: ramOverride() reports ${ns.ramOverride()} GB`);
}
