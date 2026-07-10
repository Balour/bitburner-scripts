import type { NS } from '@ns';

/**
 * Reads each probe's STATIC RAM cost without running it, revealing exactly what
 * the game's parser counts. Run: `run /probe/ram/report.js`
 */
const PROBES = [
  ['base', '1.60', 'no costed API — the floor'],
  ['dot', '3.60', 'ns.getServer via dot, in a branch that never runs'],
  ['bracket', '1.60', "ns['getServer'] — literal bracket, invisible to parser"],
  ['variable', '1.60', 'ns[key] where key comes from ns.args — invisible'],
  ['imported', '3.60', 'getServer reached only through an import'],
  ['shadow', '4.00', 'a LOCAL named `share` — charged ns.share 2.4 GB'],
  ['pinned', '1.60', 'ns.ramOverride(1.6) as first statement pins the total'],
] as const;

export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint('=== static RAM, as the game parses it ===');
  ns.tprint('   probe      actual  expect  note');
  for (const [name, expected, note] of PROBES) {
    const ram = ns.getScriptRam(`/probe/ram/${name}.js`, 'home').toFixed(2);
    const flag = ram === expected ? ' ' : '!';
    ns.tprint(` ${flag} ${name.padEnd(9)} ${ram.padStart(6)}  ${expected.padStart(6)}  ${note}`);
  }
  ns.tprint('');
  ns.tprint('  A `!` marks a prediction the game disagreed with — investigate that row.');
  ns.tprint('');
}
