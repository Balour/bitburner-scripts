/** Constants only. No NS calls, so importing this costs 0 GB. */

/** Bumped on every code change so a script can print which build is live — the
 * quick check that the sync actually pushed the latest version, not stale code. */
export const VERSION = 'v13';

/** RAM to keep free on `home` for the controllers plus their transient execs
 * (rank.js 5.45 GB during re-ranks, root.js 2.4 GB) and headroom for a bigger
 * controller later. Workers/share use home's RAM only ABOVE this. Auto-scales:
 * an 8 GB home nets negative here and is skipped; a 512 GB home offers ~475 GB. */
export const HOME_RESERVE = 32;

/** rank.js publishes its Target[] here. Port I/O is free and global across hosts. */
export const PORT_RANK = 1;

/** daemon publishes '1' here when MONEY targets are RAM-starved, '0' otherwise, so
 * auto-buy grows the pool for hacking demand only — not for XP farming, which fills
 * any RAM and would otherwise drive endless buying. */
export const PORT_RAMNEED = 2;

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
