import type { NS } from '@ns';
import { sing, reserve } from '../singularity/api';

/**
 * Read-only. Scans every megacorp faction + your joined/hacking factions, reads each unowned aug's LIVE
 * multipliers, and ranks them by value FOR A HACKING RUN — so you can see which megacorp augs cut in front
 * of the normal faction augs and which fall behind. Shows the BASE price (getAugmentationBasePrice), which
 * is escalation-free and comparable across augs — the price you actually PAY is higher by 1.9^(augs already
 * queued this batch), so don't compare against a partially-filled queue.
 *
 * Scoring (weights tuned for BN4's level->9000 endgame; edit them to taste):
 *   rep boosters (faction_rep + company_rep) x3   — they COMPOUND every future rep cycle, so they lead
 *   hacking skill                            x2   — directly raises level toward the daemon requirement
 *   hacking_exp                              x1.5 — faster leveling
 *   hacking_speed                            x1   — more ops per second = more exp
 *   hacking money cluster (money/grow/chance)x0.3 — BN4 guts hacking money, so minor
 *   charisma                                 x0.5 — speeds getting hired/promoted for company rep
 * Combat/crime/hacknet/bladeburner mults score 0 — irrelevant once the gang is the economy.
 *
 * Run: `run /probe/aug-priority.js`            top 40
 *      `run /probe/aug-priority.js --all`      every scored aug
 */
const REV = 'v1';

/** Company-gated factions (grind their job to be invited). Same names as the companies. */
const MEGACORPS = [
  'ECorp',
  'MegaCorp',
  'Bachman & Associates',
  'Blade Industries',
  'NWO',
  'Clarke Incorporated',
  'OmniTek Incorporated',
  'Four Sigma',
  'KuaiGong International',
  'Fulcrum Secret Technologies',
];

/** The normal factions to rank the megacorp augs against — hacking, endgame, and rep-aug holders. */
const FACTIONS = [
  'CyberSec',
  'NiteSec',
  'The Black Hand',
  'BitRunners',
  'The Covenant',
  'Daedalus',
  'Illuminati',
  'Tian Di Hui',
  'Netburners',
];

function scoreOf(m: Record<string, number>): number {
  const up = (k: string) => (m[k] ?? 1) - 1;
  return (
    (up('faction_rep') + up('company_rep')) * 3 +
    up('hacking') * 2 +
    up('hacking_exp') * 1.5 +
    up('hacking_speed') * 1 +
    (up('hacking_money') + up('hacking_grow') + up('hacking_chance')) * 0.3 +
    up('charisma') * 0.5
  );
}

export async function main(ns: NS) {
  const all = ns.flags([['all', false]])['all'] as boolean;
  reserve(ns, 24);
  const s = sing(ns);

  const owned = new Set(s['getOwnedAugmentations'](true));
  const scan = [...new Set([...MEGACORPS, ...FACTIONS, ...ns.getPlayer().factions])];

  interface Row {
    name: string;
    faction: string;
    mega: boolean;
    score: number;
    rep: number;
    price: number;
    repBoost: boolean;
    tags: string;
  }
  const rows = new Map<string, Row>(); // dedupe by aug; keep the lowest-rep source

  for (const f of scan) {
    const mega = MEGACORPS.includes(f);
    for (const name of s['getAugmentationsFromFaction'](f)) {
      if (owned.has(name)) continue;
      const rep = s['getAugmentationRepReq'](name);
      const prev = rows.get(name);
      if (prev && prev.rep <= rep) continue;
      const m = s['getAugmentationStats'](name);
      const key = (k: string, label: string) => ((m[k] ?? 1) !== 1 ? `${label}x${(m[k] ?? 1).toFixed(2)} ` : '');
      const tags =
        key('faction_rep', 'frep') +
        key('company_rep', 'crep') +
        key('hacking', 'hack') +
        key('hacking_exp', 'hexp') +
        key('hacking_speed', 'hspd') +
        key('hacking_money', 'hmon') +
        key('hacking_grow', 'hgrow') +
        key('hacking_chance', 'hchance') +
        key('charisma', 'cha');
      rows.set(name, {
        name,
        faction: f,
        mega,
        score: scoreOf(m),
        rep,
        price: s['getAugmentationBasePrice'](name),
        repBoost: (m.faction_rep ?? 1) > 1 || (m.company_rep ?? 1) > 1,
        tags: tags.trim() || '(no scored mults)',
      });
    }
  }

  const ranked = [...rows.values()].filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  const shown = all ? ranked : ranked.slice(0, 40);

  ns.tprint('');
  ns.tprint(`=== aug-priority ${REV} — ${ranked.length} scored augs (rep-boosters lead; the game is authority) ===`);
  ns.tprint('  #  score  where     aug — mults | rep / base$ (pre-escalation)');
  shown.forEach((r, i) => {
    const flag = `${r.repBoost ? 'R' : ' '}${r.mega ? 'M' : ' '}`;
    ns.tprint(
      `  ${String(i + 1).padStart(2)} ${r.score.toFixed(2).padStart(6)} [${flag}] ${r.faction.padEnd(24)} ` +
        `${r.name} — ${r.tags} | ${ns.format.number(r.rep)} rep / ${ns.format.number(r.price)}`,
    );
  });
  ns.tprint('  flags: R = rep-booster (compounds), M = megacorp (company-gated).');
  ns.tprint('');
}
