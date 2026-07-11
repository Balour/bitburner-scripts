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
  [
    '/daemon.js',
    '4.85',
    'net 0.25 + exec 1.3 + scp 0.6 + killall 0.5 + isRunning 0.1 + getHackTime 0.05 + hackingLevel + 4 scalars',
  ],
  ['/monitor.js', '2.40', 'net 0.25 + 4 scalars + maxRam/usedRam 0.1'],
  ['/bootstrap.js', '3.00', 'isRunning 0.1 + exec 1.3 — just a launcher'],
  ['/buy-servers.js', '5.75', 'lib/cloud: purchaseServer 2.25 + getServerNames 1.05 + cost/upgrade/limits + scalars'],
  ['/auto-buy.js', '6.05', 'lib/cloud + net 0.25 + usedRam 0.05 to gate on pool utilization'],
  ['/share.js', '3.85', 'net 0.25 + exec 1.3 + scp 0.6 + maxRam/usedRam 0.1'],
  ['/workers/share.js', '4.00', 'base + share 2.4 — one-shot, re-launched by share.js'],
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
