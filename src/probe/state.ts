import type { NS } from '@ns';

/**
 * ~2.75 GB. Read-only. Prints the BitNode/Source-File ground truth that CLAUDE.md's
 * "Where we actually are" section documents — so that section can be VERIFIED rather
 * than remembered. It drifted once already (it claimed BN1/zero-SF/8 GB while we were
 * several runs into BN2); this is the antidote.
 *
 * Run it after entering a BitNode, and any time the doc's claims look stale.
 *
 * Run: `run /probe/state.js`
 */
const REV = 'v3';

/** Programs do NOT survive entering a BitNode — only NUKE.exe carries over. So every run re-buys
 * these, and any doc claiming one is "owned" is talking about a past run until proven otherwise.
 * Free to check: RAM is charged per DISTINCT NS function, so seven fileExists calls cost the same
 * 0.1 GB as one. */
const PROGRAMS = [
  'BruteSSH.exe',
  'FTPCrack.exe',
  'relaySMTP.exe',
  'HTTPWorm.exe',
  'SQLInject.exe',
  'Formulas.exe',
  'DarkscapeNavigator.exe',
];

/** Source-Files whose absence changes what we can automate. Anything not listed is either
 * irrelevant to the script stack or interesting only for its multipliers. */
const NOTABLE: [number, string][] = [
  [1, 'home RAM on entry: 32 GB (vs 8 without it) + all multipliers'],
  [2, 'gang in ANY BitNode (BN2 also bypasses the -54k karma gate)'],
  [4, 'ns.singularity — program buying, TOR, backdoor, factions, augs'],
  // NOT "formulas without Formulas.exe" — SF-5 GRANTS the program. Prestige.ts pushes it from both
  // prestigeSourceFile and prestigeAugmentation, so it is on home from second zero of every BitNode
  // and re-granted after every install: no post-install window, nothing to re-buy. Also unlocks
  // getBitNodeMultipliers() and permanent Intelligence.
  [5, 'Formulas.exe granted every prestige + getBitNodeMultipliers() + Intelligence'],
  [9, 'home RAM on entry: 128 GB — needs level >= 2, i.e. TWO BN9 clears'],
  [10, 'ns.sleeve + grafting in any BitNode — ONE sleeve per SF level (3 max outside BN10)'],
];

export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint(`=== state ${REV} ===`);

  const info = ns.getResetInfo();
  const sf = info.ownedSF;

  ns.tprint(`  BitNode:   ${info.currentNode}`);
  ns.tprint(
    `  home RAM:  ${ns.format.ram(ns.getServerMaxRam('home'))}  (purchased upgrades; resets on entering a BitNode)`,
  );
  ns.tprint(`  in a gang: ${ns.gang.inGang() ? 'yes' : 'no'}`);

  const have = PROGRAMS.filter((p) => ns.fileExists(p, 'home'));
  const missing = PROGRAMS.filter((p) => !ns.fileExists(p, 'home'));
  ns.tprint(`  programs:  ${have.length === 0 ? 'none but NUKE.exe' : have.join(', ')}`);
  if (missing.length > 0) ns.tprint(`    missing:  ${missing.join(', ')}`);

  const owned = [...sf.entries()].sort((a, b) => a[0] - b[0]);
  ns.tprint(`  Source-Files: ${owned.length === 0 ? 'NONE' : owned.map(([n, lvl]) => `SF-${n}.${lvl}`).join(', ')}`);

  ns.tprint('  what that gates:');
  for (const [n, why] of NOTABLE) {
    const lvl = sf.get(n) ?? 0;
    ns.tprint(`    ${lvl > 0 ? `SF-${n}.${lvl}` : `SF-${n}  `.padEnd(6)} ${lvl > 0 ? 'YES' : 'no '} — ${why}`);
  }

  ns.tprint(`  augs installed: ${info.ownedAugs.size}`);
  ns.tprint('');
}
