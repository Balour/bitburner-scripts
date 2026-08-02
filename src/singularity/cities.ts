import type { NS } from '@ns';
import { liveStrategy } from '../lib/bitnode';
import { CITY_BLOCS } from '../lib/strategy';
import { sing, reserveOk } from './api';

/**
 * P2 city/location factions (Singularity), one-shot. Travels to collect the invites that can only be
 * earned by BEING somewhere, joins them, and exits. Idempotent — once everything is held it no-ops, so
 * the controller can run it on a slow timer forever.
 *
 * These are the cheapest factions in the game and the loop was ignoring all of them. A city invite costs
 * MONEY AND A PLANE TICKET, with no reputation grind at all — against a megacorp faction that wants a job,
 * stats to get hired, and hours of company rep. That was a fair trade to skip while a gang covered the
 * catalogue; on the hacking route it is not.
 *
 * ## Tian Di Hui is the reason this exists, not the cities
 *
 * TDH sells Social Negotiation Assistant at 6.25k rep / $30m — measured at rank #9 by
 * `/probe/aug-priority.js`, and a rep-booster, so it COMPOUNDS into every later faction cycle. The
 * nearest equivalent (Bachman's ADR-V2) wants 10x the rep and 18x the money. It is close to the best
 * value-per-effort in the game, and the only thing standing between us and it was a plane ticket.
 *
 * TDH also lists NO enemies, so unlike the cities it costs nothing in exclusivity — and its invite
 * requires being located in Chongqing, New Tokyo or Ishima, which are exactly the EASTERN bloc's cities.
 * One trip collects both. That, not the score table, is why eastern is the default bloc.
 *
 * ## The city blocs are mutually exclusive and joining is IRREVERSIBLE
 *
 * Verified in `Faction/FactionInfo.tsx`: Sector-12 and Aevum each omit the other from `enemies`;
 * Chongqing / New Tokyo / Ishima are mutually compatible; Volhaven is an enemy of all five. Joining any
 * member of a bloc permanently forecloses the other two blocs for the rest of the BitNode. That is why
 * the choice is a single `rep.cityBloc` value rather than six independent flags — a shape that cannot
 * express a self-locking-out configuration.
 *
 * Run: `run /singularity/cities.js`
 */
const REV = 'v1';

/** `ns.singularity.travelToCity` charges this per flight (CONSTANTS.TravelCost). Small, but the whole
 * point of the affordability gate is to never spend it on a trip that cannot end in a join. */
const TRAVEL_COST = 200e3;

const TIAN_DI_HUI = 'Tian Di Hui';
/** TDH's invite needs us LOCATED in one of these — membership in them is irrelevant, so this works from
 * any bloc. Chongqing first: it is also the cheapest eastern city to actually join ($20m). */
const TDH_CITIES = ['Chongqing', 'New Tokyo', 'Ishima'];
const TDH_COST = 1e6;
const TDH_HACKING = 50;

export async function main(ns: NS) {
  // ~10.2 GB: base 1.6 + travelToCity 2 + joinFaction 3 + checkFactionInvitations 3 + getPlayer 0.5
  // + getServerMoneyAvailable 0.1. All Singularity base rates (x1 at SF-4.3).
  if (!reserveOk(ns, 16, 11)) return;
  const s = sing(ns);
  const strat = liveStrategy(ns, ns.getResetInfo().currentNode);
  const bloc = CITY_BLOCS[strat.rep.cityBloc];
  const money = () => ns.getServerMoneyAvailable('home');

  const joined = new Set<string>(ns.getPlayer().factions);
  const startCity = ns.getPlayer().city as string;

  /** Fly somewhere, but only when the trip can actually pay off. Travelling without the join money is
   * pure waste — the invite simply will not appear, and we would fly back next pass and try again. */
  const goIfWorthIt = (city: string, joinCost: number): boolean => {
    if (ns.getPlayer().city === city) return true;
    if (money() < joinCost + TRAVEL_COST) return false;
    return s['travelToCity'](city);
  };

  /** Accept every invite we are holding that we actually want. Called after each hop, because an invite
   * appears the moment its conditions are met — including the instant we land. */
  const acceptInvites = (want: (f: string) => boolean) => {
    for (const inv of s['checkFactionInvitations']()) {
      if (!want(inv) || joined.has(inv)) continue;
      if (s['joinFaction'](inv)) {
        joined.add(inv);
        ns.tprint(`=== cities ${REV} — joined ${inv} ===`);
      }
    }
  };

  // 1. TIAN DI HUI first. It is the highest-value target here, it has no enemies so it can never conflict
  //    with a bloc decision, and its cities overlap the eastern bloc — so doing it first means the bloc
  //    hop below is usually already done.
  if (!joined.has(TIAN_DI_HUI)) {
    if (ns.getPlayer().skills.hacking < TDH_HACKING) {
      ns.print(`cities: hacking ${ns.getPlayer().skills.hacking} < ${TDH_HACKING} for ${TIAN_DI_HUI} — later.`);
    } else {
      // Prefer a city this bloc wants anyway, so one flight serves both goals.
      const target = TDH_CITIES.find((c) => bloc.includes(c)) ?? TDH_CITIES[0];
      if (goIfWorthIt(target, TDH_COST)) acceptInvites((f) => f === TIAN_DI_HUI);
    }
  }

  // 2. The city bloc. `cityBloc: 'none'` leaves this empty and the whole step is skipped, which is the
  //    conservative default — joining is irreversible for the rest of the BitNode.
  for (const city of bloc) {
    if (joined.has(city)) continue;
    // The invite condition is `locatedInCity(city) && haveMoney(n)`, and the money figure differs per
    // city. We do not hardcode those: fly only when we hold the most expensive one ($50m covers all six),
    // then let the game decide which invites it actually offers. One threshold, no table to drift.
    if (!goIfWorthIt(city, 50e6)) continue;
    acceptInvites((f) => bloc.includes(f));
  }

  // 3. Go home. Being parked in a foreign city silently changes what OTHER things do — gym choice in
  //    crime.ts, company availability for repwork.ts — so leaving the player somewhere unexpected is a
  //    side effect this script has no business having.
  if (ns.getPlayer().city !== startCity && money() > TRAVEL_COST) s['travelToCity'](startCity);

  const missing = [...bloc, TIAN_DI_HUI].filter((f) => !joined.has(f));
  if (missing.length === 0) ns.print(`cities ${REV}: all location factions held — nothing to do.`);
  else ns.print(`cities ${REV}: still want ${missing.join(', ')} (money or hacking short).`);
}
