import type { NS } from '@ns';

/**
 * Checks every automation script's STATIC RAM against the budget we designed to.
 * A mismatch means a stray import or an identifier that collided with an NS API
 * name — both silent, both expensive on workers.
 *
 * Run: `run /probe/ram/budget.js`
 */
const BUDGET = [
  ['/workers/hack.js', '1.70', 'base + hack 0.1 — must never grow'],
  ['/workers/grow.js', '1.75', 'base + grow 0.15 — must never grow'],
  ['/workers/weaken.js', '1.75', 'base + weaken 0.15 — must never grow'],
  ['/root.js', '2.40', 'net 0.25 + fileExists 0.1 + 5 openers 0.25 + nuke 0.05 + ports 0.1 + maxRam 0.05'],
  [
    '/rank.js',
    '5.45',
    'net 0.25 + hackAnalyze 1 + hackAnalyzeChance 1 + growthAnalyze 1 + getHackTime 0.05 + 5 scalars',
  ],
  // Formulas path: formulas.* are 0 GB; the cost is getServer 2 + getPlayer 0.5,
  // which replaces the fallback's hackAnalyze/hackAnalyzeChance/growthAnalyze (3 GB).
  ['/rank-formulas.js', '4.40', 'net 0.25 + getServer 2 + getPlayer 0.5 + formulas 0 + hackingLevel 0.05'],
  // Free NS only (ns.format, port I/O, ns.write, ns.tprint) — must stay 0-cost so
  // importing it adds nothing to either rank file.
  ['/lib/rank-core.js', '1.60', 'base only — pure scoring + free NS (format/ports/write/tprint)'],
  [
    '/daemon.js',
    '4.95',
    "net 0.25 + exec 1.3 + scp 0.6 + killall 0.5 + isRunning 0.1 + fileExists 0.1 + getHackTime 0.05 + hackingLevel + 4 scalars; phases['weaken'] bracketed to dodge ns.weaken 0.15",
  ],
  ['/monitor.js', '2.40', 'net 0.25 + 4 scalars + maxRam/usedRam 0.1'],
  [
    '/map.js',
    '2.30',
    'scan 0.2 + fileExists 0.1 + hasRootAccess 0.05 + numPorts/reqLevel/maxMoney 0.3 + hackingLevel 0.05',
  ],
  [
    '/bootstrap.js',
    '4.10',
    'isRunning 0.1 + exec 1.3 + maxRam/usedRam 0.1 + getResetInfo 1 + inGang 0 + flags 0 — just a launcher',
  ],
  ['/probe/state.js', '2.75', 'getResetInfo 1 + fileExists 0.1 + maxRam 0.05 + inGang 0 — read-only'],
  // Gang. Split deliberately: one script referencing the whole gang API costs ~37 GB, which does
  // not fit the 32 GB home a fresh BitNode gives you. The controller holds only the cheap loop and
  // execs the expensive helpers one at a time, so peak is ~26 GB, not 37.
  [
    '/gang.js',
    '13.20',
    'gangInfo 2 + memberNames 1 + memberInfo 2 + recruit 2 + setTask 2 + taskStats 1 + exec 1.3 + fileExists 0.1 + money 0.1 + hack 0.1',
  ],
  ['/gang/found.js', '2.60', 'createGang 1 — inGang and ns.enums are 0 GB'],
  ['/gang/ascend.js', '8.70', 'memberNames 1 + getAscensionResult 2 + ascendMember 4 + hack 0.1'],
  [
    '/gang/equip.js',
    '16.70',
    'gangInfo 2 + memberNames 1 + memberInfo 2 + equipType 2 + equipStats 2 + equipCost 2 + purchase 4 + money 0.1',
  ],
  ['/gang/territory.js', '11.60', 'gangInfo 2 + allGangInfo 2 + clashChance 4 + setWarfare 2'],
  // 1.70, not 1.60: reading `member.hack` in the scoring math collides with ns.hack in the static
  // parser's flat name table. `member.moneyGain`/`.respectGain` collide with ns.formulas.gang.* —
  // which are 0 GB, so those are free. Importing only the constants from here still costs nothing.
  ['/lib/gang.js', '1.70', 'base + hack 0.1 (property-name collision) — pure math, no NS calls'],
  ['/buy-servers.js', '5.75', 'lib/cloud: purchaseServer 2.25 + getServerNames 1.05 + cost/upgrade/limits + scalars'],
  ['/auto-buy.js', '5.75', 'lib/cloud + getServerMoneyAvailable; gates on the daemon RAM-need port (0 GB peek)'],
  ['/share.js', '3.85', 'net 0.25 + exec 1.3 + scp 0.6 + maxRam/usedRam 0.1'],
  ['/hacknet.js', '7.20', 'money 0.1 + 11 distinct hacknet.* at 0.5 each = 5.5 (NOT 0 GB)'],
  ['/workers/share.js', '4.00', 'base + share 2.4 — one-shot, re-launched by share.js'],
  ['/contracts/loop.js', '3.00', 'base 1.6 + exec 1.3 + isRunning 0.1 — resident periodic solver'],
  ['/contracts/catalog.js', '1.60', 'getContractTypes is 0 GB'],
  // Imports only `crawl`, so it pays scan 0.2 but NOT `rooted`'s hasRootAccess.
  ['/contracts/find.js', '2.00', 'crawl only 0.2 + ls 0.2 — named imports charge per symbol'],
  ['/contracts/inspect.js', '12.25', 'getContractType 5 + getData 5 + scp 0.6 — 16 GB host only'],
] as const;

export async function main(ns: NS) {
  ns.tprint('');
  ns.tprint('=== static RAM vs budget ===');
  ns.tprint('   script                  actual  budget  note');

  let bad = 0;
  for (const [file, expected, note] of BUDGET) {
    const ram = ns.getScriptRam(file, 'home').toFixed(2);
    const flag = ram === expected ? ' ' : '!';
    if (flag === '!') bad += 1;
    ns.tprint(` ${flag} ${file.padEnd(22)} ${ram.padStart(6)}  ${expected.padStart(6)}  ${note}`);
  }

  ns.tprint('');
  ns.tprint(
    bad === 0
      ? '  All scripts match budget.'
      : `  ${bad} mismatch(es). A higher actual means a leaked import or a local named after an NS API.`,
  );
  ns.tprint('');
}
