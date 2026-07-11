import type { NS } from '@ns';

/**
 * 4.00 GB (1.6 base + share 2.4). One share() call lasts ShareBonusTime (~10s),
 * then the process exits so its RAM frees for the daemon. share.ts re-launches
 * these each cycle to keep the reputation bonus topped up — that one-shot design
 * is what lets share yield to hacking within ~10s instead of hogging RAM forever.
 */
export async function main(ns: NS) {
  await ns.share();
}
