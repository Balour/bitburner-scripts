/** Constants only. No NS calls, so importing this costs 0 GB. */

/** Repo-wide BUILD stamp. Bumped on any code change anywhere; every persistent script prints it.
 * It answers one question — "did the sync push my latest code, or is the game running something
 * stale?" — and nothing else.
 *
 * It deliberately does NOT tell you which revision of a given script is running: it moves when an
 * unrelated file changes. Each script carries its own `REV` for that, printed as
 * `daemon v3 [build v17]`. Bump a script's REV when THAT script's behaviour changes; bump VERSION
 * on any change at all. */
export const VERSION = 'v68';

/** RAM to keep free on `home` for the controllers' TRANSIENT execs. Workers/share size themselves
 * as `maxRam - used - HOME_RESERVE`, and `used` already covers the resident controllers — so this
 * is purely headroom for the short-lived scripts they spawn. Worst case they overlap:
 * gang helper 12.7 (equip.js, the fattest) + rank.js 5.45 + root.js 2.4 = 20.55 GB. 32 covers it.
 * Auto-scales: an 8 GB home nets negative here and is skipped; a 512 GB home offers ~475 GB. */
export const HOME_RESERVE = 32;

/** rank.js publishes its Target[] here. Port I/O is free and global across hosts. */
export const PORT_RANK = 1;

/** daemon publishes '1' here when MONEY targets are RAM-starved, '0' otherwise, so
 * auto-buy grows the pool for hacking demand only — not for XP farming, which fills
 * any RAM and would otherwise drive endless buying. */
export const PORT_RAMNEED = 2;

/** gang/territory.js publishes the warfare verdict here — `{ wantPower, engaged, minChance }` —
 * so the gang controller knows whether to staff members onto Territory Warfare. The controller
 * cannot compute it itself: getChanceToWinClash is 4 GB and getAllGangInformation another 2. */
export const PORT_GANG = 3;

/** The reverse channel: the gang controller publishes '1' here while it is BUILDING power (the whole
 * roster on Territory Warfare), '0' otherwise, so gang/territory.js knows whether we are actually
 * investing in the war before it starts one.
 *
 * It cannot infer this. `resetGangs()` starts EVERY gang — ours and all six rivals — at power 1 and
 * territory 1/7, so `getClashWinChance` reads exactly 0.5 against everyone at hour zero of a fresh
 * BitNode. That clears CLASH_ENGAGE_FLOOR on the first helper run, while the roster is still 3
 * members, nobody is on warfare, and our power consequently cannot grow at all — we would clash
 * until the disengage floor caught us. Engaging is only ever right when someone is building the
 * power to back it. */
export const PORT_GANG_BUILD = 4;

/** The Singularity controller publishes its progress record here (phase, karma, homicide%, factions,
 * augs, last/next action + timestamp) for monitor.js and for debugging an unattended run. Free I/O. */
export const PORT_SING_STATUS = 5;

/** Manual-play opt-out: write '1' here to make the Singularity controller yield the player action slot
 * (it stops its current action and idles); '0' or empty to resume. Lets you sit down and play without
 * the crime/faction grind fighting you for the slot. */
export const PORT_SING_PAUSE = 6;

/** Written on `home` for humans and for monitor.js. `ns.read`/`ns.write` are 0 GB. */
export const TARGETS_FILE = '/data/targets.json';

/** The Singularity controller's progress record, mirrored to disk so it survives restarts. */
export const SING_FILE = '/data/singularity.json';

/** Where contracts/find.js records what it located. */
export const CONTRACTS_FILE = '/data/contracts.json';

/** Fraction of a server's CURRENT money one batch's hack steals. */
export const HACK_FRACTION = 0.25;

/** Multiplier one batch's grow applies. Must exceed 1/(1-HACK_FRACTION) = 1.333 so
 * money climbs toward max while we harvest, instead of merely holding station.
 * growthAnalyze(host, GROW_MULT) gives the grow threads; rank computes it remotely
 * because growthAnalyze costs 1 GB, which the lean daemon cannot afford. */
export const GROW_MULT = 1.5;

/** Per-BitNode default opt-outs for the bootstrap stack. Maps BitNode number -> stack keys that
 * bootstrap skips BY DEFAULT there, because the subsystem isn't worth its RAM. Key 0 applies to
 * EVERY BitNode; a specific number is unioned on top. e.g. BN4 runs hacknet at ~5% production.
 * Per-run overrides still win: --<key> forces it on for one run, --no-<key> forces it off. */
export const BN_DISABLE: Record<number, string[]> = {
  0: [], // always-off list (currently none)
  // BN4: hacknet ~5% of normal. monitor/share/auto-buy are held off during the karma grind so the ~26 GB
  // Singularity controller fits a 32 GB home alongside the daemon (it runs on home, where HOME_RESERVE
  // protects it from the daemon's pool workers — running it on a pool host lets the daemon steal its RAM).
  // Re-enable them (e.g. `run /bootstrap.js --auto-buy`) once home is upgraded past ~48 GB and there's room.
  4: ['hacknet', 'monitor', 'share', 'auto-buy'],
};
