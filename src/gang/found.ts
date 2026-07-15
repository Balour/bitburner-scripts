import type { NS } from '@ns';

/**
 * ~2.6 GB. One-shot. Founds a gang with the best faction we've actually joined.
 *
 * There is no non-Singularity way to list joined factions, so we don't try: `createGang` already
 * returns false unless we're a member, so walking the preference list in order IS the membership
 * test. Combat gangs only — hacking gangs (NiteSec, The Black Hand) are never preferred, because
 * every hacking task has a territory exponent of 1 while combat tasks reach 2.0.
 *
 * Inside BN2 that's the whole story. Outside BN2 you also need SF-2 and karma <= -54,000, and
 * The Syndicate leads the list because there the founding faction's own augmentations are the
 * only guaranteed ones (GangUniqueAugs < 1 makes every other faction's exclusives a coin-flip).
 *
 * Run: `run /gang/found.js`
 */
export async function main(ns: NS) {
  if (ns.gang.inGang()) {
    ns.tprint('INFO  already in a gang — nothing to do.');
    return;
  }

  const faction = ns.enums.FactionName;
  const preference = [
    faction.TheSyndicate,
    faction.SlumSnakes,
    faction.Tetrads,
    faction.TheDarkArmy,
    faction.SpeakersForTheDead,
  ];

  for (const name of preference) {
    if (ns.gang.createGang(name)) {
      ns.tprint(`SUCCESS  founded a gang with ${name}. Now run /bootstrap.js.`);
      return;
    }
  }

  ns.tprint('ERROR  could not found a gang. You must be a member of a gang faction first.');
  ns.tprint(`        Tried: ${preference.join(', ')}`);
  ns.tprint('        Slum Snakes is the cheapest way in: karma <= -9, all combat stats >= 30, $1m.');
}
