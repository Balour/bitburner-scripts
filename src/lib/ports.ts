/** Constants only. No NS calls, so importing this costs 0 GB. */

/** Bumped on every code change so a script can print which build is live — the
 * quick check that the sync actually pushed the latest version, not stale code. */
export const VERSION = 'v6';

/** rank.js publishes its Target[] here. Port I/O is free and global across hosts. */
export const PORT_RANK = 1;

/** Written on `home` for humans and for monitor.js. `ns.read`/`ns.write` are 0 GB. */
export const TARGETS_FILE = '/data/targets.json';

/** Where contracts/find.js records what it located. */
export const CONTRACTS_FILE = '/data/contracts.json';

/** Fraction of a server's CURRENT money one batch's hack steals. */
export const HACK_FRACTION = 0.25;

/** Multiplier one batch's grow applies. Must exceed 1/(1-HACK_FRACTION) = 1.333 so
 * money climbs toward max while we harvest, instead of merely holding station.
 * growthAnalyze(host, GROW_MULT) gives the grow threads; rank computes it remotely
 * because growthAnalyze costs 1 GB, which the lean daemon cannot afford. */
export const GROW_MULT = 1.5;
