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
 * Combat/crime/hacknet/bladeburner mults score 0 — this ranks a HACKING run. On a gang-route node the
 * karma grind wants the opposite early on, and `augs.ts` handles that itself with a live combat filter;
 * do not read this list as advice for that phase.
 *
 * Two sections follow the ranking, and both exist because the flat list cannot express them:
 *   CITY BLOCS      — the three mutually-exclusive city choices, scored by MARGINAL augs, with where they
 *                     land in the overall queue. Answers "which bloc, and before or after the hacking
 *                     factions" without joining anything.
 *   SPECIAL-EFFECT  — augs with no multipliers at all, so unscoreable here and otherwise invisible.
 *
 * Run: `run /probe/aug-priority.js`            top 40 + bloc rollup
 *      `run /probe/aug-priority.js --all`      every scored aug
 */
const REV = 'v5';

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

/**
 * CITY factions, scanned so their augs can be compared before committing to a bloc. `getAugmentationsFromFaction`
 * works on factions you have NOT joined, so this prices the choice without making it.
 *
 * They matter far more on the hacking route than they did on the gang route. Gang factions cover most
 * combat/crime augs, so skipping cities cost little — but without a gang the binding constraint is the
 * DAEDALUS 30-AUG COUNT, and every extra faction is extra distinct augs toward it.
 *
 * They are mutually exclusive in BLOCS, not individually (verified in `Faction/FactionInfo.tsx` — the
 * `enemies` arrays). Joining one member of a bloc does not cost you the others:
 *   Sector-12 + Aevum                    — each omits the other from its enemies
 *   Chongqing + New Tokyo + Ishima       — mutually compatible
 *   Volhaven                             — enemies with all five, so it is a solo pick
 * Tian Di Hui lists NO enemies and needs only to be LOCATED in Chongqing/New Tokyo/Ishima, which is travel
 * rather than membership — so it is compatible with every bloc and already in FACTIONS above.
 */
const CITY_FACTIONS = ['Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima'];

/**
 * The three mutually-exclusive choices, with the money THRESHOLD each needs. `haveMoney(n)` in
 * `inviteReqs` checks your balance and spends nothing — same as Daedalus's $100b — so joining a city is
 * FREE, and `need` below is the largest balance the bloc requires, not a price. With no rep grind either,
 * these are the cheapest factions in the game by a wide margin.
 *
 * Exclusive within an install cycle only: `prestigeAugmentation` wipes membership, so a different bloc
 * next cycle costs nothing. One decision with three outcomes, remade every reset.
 */
const BLOCS: { name: string; factions: string[]; need: number }[] = [
  { name: 'EASTERN  Chongqing + New Tokyo + Ishima', factions: ['Chongqing', 'New Tokyo', 'Ishima'], need: 30e6 },
  { name: 'WESTERN  Sector-12 + Aevum', factions: ['Sector-12', 'Aevum'], need: 40e6 },
  { name: 'SOLO     Volhaven', factions: ['Volhaven'], need: 50e6 },
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
  const scan = [...new Set([...MEGACORPS, ...FACTIONS, ...CITY_FACTIONS, ...ns.getPlayer().factions])];

  interface Row {
    name: string;
    faction: string;
    mega: boolean;
    score: number;
    /** No multiplier anywhere — the value is a game-code effect this probe cannot score. Judge by hand. */
    special: boolean;
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
      // An aug with NO multiplier anywhere is a SPECIAL-EFFECT aug, not a worthless one — the effect lives
      // in game code, not in `Multipliers`, so nothing here can score it. CashRoot Starter Kit ($1m +
      // BruteSSH.exe after every install) and Neuroreceptor Management Implant (no unfocused-work penalty)
      // are the cases that matter, and both would otherwise be filtered out by `score > 0` — silently
      // hiding the augs most valuable to a loop that installs repeatedly. Detected rather than hardcoded,
      // so the list cannot go stale against a game update.
      const special = Object.values(m as unknown as Record<string, number>).every((v) => v === 1);
      rows.set(name, {
        name,
        faction: f,
        mega,
        score: scoreOf(m),
        special,
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

  // Listed separately BECAUSE they cannot be ranked: no multipliers means nothing to score, so the
  // ordering above is meaningless for them and putting them in it would imply a judgement we cannot make.
  // BLOC ROLLUP. The bloc choice is one decision with three outcomes, so what matters is not "are city
  // augs good" but "which bloc's augs outrank what I already have access to, and by how much".
  //
  // `rows` is deduped by aug keeping the LOWEST-REP source, which does exactly the right thing here: an
  // aug a city sells that some hacking faction sells cheaper is attributed to the hacking faction, so it
  // never counts toward a bloc it would not actually unlock. What each bloc scores below is therefore its
  // MARGINAL value — augs you get by joining it and cannot get better elsewhere.
  //
  // Rank positions are against the full ranked list, which is the number that answers "buy these before
  // or after the hacking factions?". A bloc whose best aug sits at #40 is a late-queue bloc however many
  // augs it has.
  const rankOf = new Map(ranked.map((r, i) => [r.name, i + 1]));
  ns.tprint('');
  ns.tprint('  --- CITY BLOCS: mutually exclusive, pick ONE. Marginal augs only (cheaper sources excluded) ---');
  for (const bloc of BLOCS) {
    const mine = [...rows.values()].filter((r) => bloc.factions.includes(r.faction));
    const scored = mine.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    const spec = mine.filter((r) => r.special);
    const best = scored[0];
    const total = scored.reduce((sum, r) => sum + r.score, 0);
    ns.tprint(`   ${bloc.name}  —  needs $${ns.format.number(bloc.need)} on hand (threshold, not a cost)`);
    ns.tprint(
      `      ${mine.length} marginal aug(s) toward the Daedalus count` +
        ` · ${scored.length} scored, total ${total.toFixed(2)}` +
        `${spec.length ? ` · ${spec.length} special-effect` : ''}` +
        `${best ? ` · best: ${best.name} (${best.score.toFixed(2)}, overall #${rankOf.get(best.name)})` : ''}`,
    );
    // Where the bloc's augs actually land in the queue — the median rank is the honest summary, since one
    // strong aug does not make a bloc worth joining if the rest sit at the bottom.
    if (scored.length > 0) {
      const positions = scored.map((r) => rankOf.get(r.name) ?? ranked.length).sort((a, b) => a - b);
      const median = positions[Math.floor(positions.length / 2)];
      ns.tprint(`      overall ranks ${positions[0]}..${positions[positions.length - 1]}, median #${median}`);
    }
  }
  ns.tprint('   (total score compares blocs; median rank says whether to buy them BEFORE or AFTER the');
  ns.tprint('    hacking factions. Special-effect augs are unscored — read them in the section below.)');

  // THE COUNT, reported separately from the SCORE because on the hacking route they are different
  // questions and the count is usually the binding one. Daedalus needs DaedalusAugsRequirement augs
  // INSTALLED before it will invite, and combat-only augs score 0 here while counting perfectly well
  // toward that — so a bloc can be worthless for hacking value and still be the fastest way through the
  // gate. Reachable = every unowned aug sold by a faction we are already IN, i.e. no new membership,
  // no travel, no company grind.
  const joined = new Set<string>(ns.getPlayer().factions);
  const reachable = [...rows.values()].filter((r) => joined.has(r.faction)).length;
  const installed = s['getOwnedAugmentations'](false).length;
  ns.tprint('');
  ns.tprint(
    `  --- DAEDALUS COUNT: ${installed} installed, ${reachable} more reachable without joining anything new ---`,
  );
  ns.tprint("      Compare against the node's DaedalusAugsRequirement (run /probe/bitnode.js — 30 in BN1).");
  ns.tprint('      If installed + reachable already clears it, the city blocs buy you NOTHING on count and');
  ns.tprint('      the only reason to join one is the scored value above.');

  const specials = [...rows.values()].filter((r) => r.special).sort((a, b) => a.rep - b.rep);
  if (specials.length > 0) {
    ns.tprint('');
    ns.tprint(`  --- ${specials.length} SPECIAL-EFFECT aug(s): no multipliers, so unscored. Judge these by hand. ---`);
    for (const r of specials) {
      ns.tprint(
        `      ${r.faction.padEnd(24)} ${r.name} | ${ns.format.number(r.rep)} rep / ${ns.format.number(r.price)}`,
      );
    }
    ns.tprint('      (e.g. CashRoot Starter Kit pays $1m + BruteSSH.exe back on EVERY install.)');
  }
  ns.tprint('');
}
