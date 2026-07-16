import type { NS } from '@ns';
import type { GangInfo, MemberInfo, TaskStats } from './lib/gang';
import {
  CLASH_ENGAGE_FLOOR,
  GANG_CASH_RESERVE,
  EARN_UNLOCK_RESPECT,
  MAX_MEMBERS,
  POWER_BUILD_MAX_MS,
  POWER_MEMBERS,
  POWER_UPDATE_MS,
  TASK_IDLE,
  TASK_TRAIN_COMBAT,
  TASK_TRAIN_HACKING,
  TASK_VIGILANTE,
  TASK_WARFARE,
  VIGILANTE_MAX_FRACTION,
  WANTED_LEVEL_FLOOR,
  WANTED_PENALTY_FLOOR,
  memberPower,
  moneyScore,
  ourPowerRate,
  powerToHold,
  respectScore,
  territoryRate,
  updatesToChance,
  wantedGain,
} from './lib/gang';
import { PORT_GANG, PORT_GANG_BUILD, VERSION } from './lib/ports';

/**
 * ~13.1 GB. The gang controller: recruit, assign tasks, hold the wanted level down.
 *
 * In BN2 the gang IS the economy — hacking is gutted (ServerMaxMoney 0.08) and the gang faction
 * is the only seller of The Red Pill. Everything expensive is pushed into short-lived helpers
 * (ascend / equip / territory) exec'd round-robin, so peak RAM stays ~26 GB rather than the
 * ~37 GB a single script referencing the whole gang API would cost.
 *
 * Gang-type agnostic on purpose: the legal task list comes from `getTaskNames()`, which the game
 * already filters by hacking-vs-combat. The same code drives either kind, in any BitNode.
 *
 * Run: `run /gang.js` (bootstrap launches it whenever `ns.gang.inGang()`).
 */

/** This script's own revision. v2: the first cut deadlocked the gang — it gated vigilante duty on
 * wantedPenalty, which reads 0 on a brand-new gang (wanted floors at 1, respect starts at 0), so
 * every member was parked on a task that earns no respect and the ratio could never recover.
 * v3: status line showed wantedPenalty as-is ("penalty 97.92%"), which reads as a huge penalty
 * when it's the fraction of gains KEPT. Now shown as the game does — a reduction (-2.08%).
 * v4: added an `invested` line (owned augs/gear + cash vs reserve) so gang spending is visible —
 * equip.js reports nothing itself. Reworked equip.js to fund durable augs down to a cash reserve
 * rather than a stingy 10% slice, so idle cash actually flows into the gang.
 * v5: members now TRAIN until they can do a high-tier task instead of settling on Mug. Exp scales
 * with difficulty^0.9, so mugging builds stats ~63x slower than Train Combat — the ranker's
 * respect-priority was keeping members weak and stalling the whole gang below the stat wall.
 * v6: territory. POWER_MEMBERS was 4, which MEASURABLY LOST the power race (gap to Speakers widened
 * 4,100 -> 4,132 in ~27 min) — it staffed the weakest earners and produced 0.84/update against a
 * rival's passive 1.23. Now the full roster builds, gated on a computed time-to-engage so a weak
 * roster earns instead of forfeiting income to a race it cannot finish; the roster keeps pushing
 * through the clash phase until dominant (standing down at the engage floor collapses power); and
 * ascension pauses during a build, since it zeroes the very stats power is summed from.
 * v7: v6 crashed on start. Ports persist across restarts, so PORT_GANG still held v5's payload,
 * whose missing rivalPower/rivalRate reached ns.format.number as undefined. readWarfare now
 * validates every field, and staffing requires rivalPower > 0 so a bad payload can't trigger a
 * blackout.
 * v8: publishes `building` on PORT_GANG_BUILD. resetGangs() starts every gang at power 1, so a fresh
 * BitNode reads a 0.5 clash chance against all six rivals from tick one — enough to clear the engage
 * floor with a 3-member roster and nobody on warfare. territory.js now needs this flag to start a
 * war. Untestable from a mature save; found by reading resetGangs, not by running.
 * v9: status shows the conquest eta while clashing instead of a meaningless `eta 0` (the build eta
 * measures time to the ENGAGE floor, which is behind us by then). Rate math verified live: predicted
 * +0.406pp over ~28 updates, observed +0.428pp.
 * v10: three linked fixes, all from watching the release actually fire. Standing the roster down at
 * a 90% win chance cost ~96% of our power rate (10.284 -> 0.411/update) and would have tripled the
 * conquest, to buy pre-conquest income worth ~1/260th of the prize — so staffing now holds until the
 * rival's territory is gone. Ascension resumed at that release and gutted the roster (respect
 * 1.999m -> 353k, gear destroyed), so its pause now spans the whole war, not just the build. And
 * equip.js stops buying augs mid-conquest: their price tracks 1/respect, and respect is about to go
 * up ~100x.
 * v11: v10's "stay all-in until the rival's territory is gone" quoted a stale multiplier as if it
 * were constant. Finishing an hour sooner was worth ~262x income at 17.5% territory but only ~67x at
 * 33% and ~7x by 67% — the argument for the roster decays as we conquer and crosses over before the
 * war ends. Warfare is now a GARRISON sized by powerToHold (~rivalPower * 0.0159, independent of our
 * own power, and shrinking as territory rises), so members return to earning as the war winds down.
 * Also: personal augmentations are NOT discounted, so pre-conquest income does have a sink — the
 * claim that it had none was wrong. */
const REV = 'v11';

const HELPER_ASCEND = '/gang/ascend.js';
const HELPERS = [HELPER_ASCEND, '/gang/equip.js', '/gang/territory.js'];
/** Ticks between helper launches. One at a time, so peak RAM stays bounded. */
const HELPER_EVERY = 5;
const TICK_MS = 2000; // the gang itself only processes every 2s
const BONUS_TICK_MS = 200; // burn down bonus time faster when the game hands us some

interface Warfare {
  engaged: boolean;
  minChance: number;
  rivalPower: number;
  rivalRate: number;
  rivalTerritory: number;
}

/**
 * Ports are global and PERSIST across script restarts, so this may hold the payload written by the
 * PREVIOUS version of territory.js — which is exactly what happens on every schema change, for the
 * ~30s until the helper's next round-robin turn rewrites it. v5's `{wantPower, engaged, minChance}`
 * has no rivalPower/rivalRate, and reading them straight off the parse fed `undefined` into
 * ns.format.number, which throws. So validate every field instead of trusting the shape: a port is a
 * cross-version interface, not a private channel.
 */
function readWarfare(ns: NS): Warfare {
  const raw = ns.peek(PORT_GANG);
  const fallback: Warfare = { engaged: false, minChance: 0, rivalPower: 0, rivalRate: 0, rivalTerritory: 0 };
  if (typeof raw !== 'string' || raw.startsWith('NULL')) return fallback;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const num = (value: unknown, dflt: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : dflt;
  return {
    engaged: parsed.engaged === true,
    minChance: num(parsed.minChance, 0),
    rivalPower: num(parsed.rivalPower, 0),
    rivalRate: num(parsed.rivalRate, 0),
    rivalTerritory: num(parsed.rivalTerritory, 0),
  };
}

/** Fill empty slots. The first 3 members are free; after that each costs exponentially more
 * respect, so this quietly does nothing until the respect phase has earned enough. */
function recruit(ns: NS): void {
  for (;;) {
    const names = ns.gang.getMemberNames();
    if (names.length >= MAX_MEMBERS) return;
    const info = ns.gang.getGangInformation();
    // Bracket access, not `info.respectForNextRecruit`: the static parser matches bare property
    // names against the whole NS table, and that name collides with ns.gang.respectForNextRecruit()
    // — 1 GB for a field we already have in hand. A string-literal key is invisible to it, and this
    // still just reads a plain object, so there is no dynamic cost either. Measured: 14.10 -> 13.10.
    if (info.respect < info['respectForNextRecruit']) return;
    if (!ns.gang.recruitMember(`g-${names.length}`)) return;
  }
}

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.print(`gang ${REV} [build ${VERSION}] starting`);

  if (!ns.gang.inGang()) {
    ns.print('ERROR  not in a gang — run /gang/found.js first');
    ns.tprint('ERROR  gang.js: not in a gang. Join a gang faction, then `run /gang/found.js`.');
    return;
  }

  // Task stats are static, so pay getTaskStats (1 GB a call) once rather than every tick.
  const tasks: TaskStats[] = ns.gang
    .getTaskNames()
    .filter((name) => name !== TASK_IDLE)
    .map((name) => ns.gang.getTaskStats(name));
  const byName = (name: string): TaskStats | undefined => tasks.find((task) => task.name === name);
  const useFormulas = ns.fileExists('Formulas.exe', 'home');

  ns.print(`  ${tasks.length} tasks, ${useFormulas ? 'exact (Formulas.exe)' : 'fallback'} scoring`);

  for (let tick = 0; ; tick++) {
    recruit(ns);

    const info = ns.gang.getGangInformation();
    const members = ns.gang.getMemberNames().map((name) => ns.gang.getMemberInformation(name));
    const warfare = readWarfare(ns);
    const { plan, building } = assign(ns, info, members, tasks, byName, warfare, useFormulas);

    // Tell territory.js whether we're actually backing a war before it starts one. Port I/O is 0 GB.
    ns.clearPort(PORT_GANG_BUILD);
    ns.writePort(PORT_GANG_BUILD, building ? '1' : '0');

    for (const member of members) {
      const task = plan.get(member.name);
      if (task && member.task !== task) ns.gang.setMemberTask(member.name, task);
    }

    if (tick % HELPER_EVERY === 0) {
      const helper = HELPERS[Math.floor(tick / HELPER_EVERY) % HELPERS.length];
      // Ascension resets a member's stats to base — it keeps the multiplier and the exp curve does
      // the rest. Normally that's a good trade and ascend.js should take it. During a power build it
      // is not: power is the CURRENT stat sum, so ascending a 340-power member drops them to ~20 for
      // hours, and the whole point of the blackout is to cash the roster's present stats into power
      // before the rival's passive ~1.2/update outruns us. Pause it; resume once we're dominant.
      if (!building || helper !== HELPER_ASCEND) ns.exec(helper, 'home');
    }

    status(ns, info, members, plan, warfare, building);

    const bonus = ns.gang.getBonusTime();
    await ns.sleep(bonus > TICK_MS ? BONUS_TICK_MS : TICK_MS);
  }
}

/**
 * Decide every member's task for this tick.
 *
 * Order matters. A freshly recruited member has level-1 stats, and every gain formula subtracts
 * `difficultyPenalty * task.difficulty` from the weighted stat sum — so even Mug People
 * (difficulty 1) scores 0 for them. Untrained members MUST train, or the gang produces nothing
 * and never recruits past the three free slots.
 */
function assign(
  ns: NS,
  info: GangInfo,
  members: MemberInfo[],
  tasks: TaskStats[],
  byName: (name: string) => TaskStats | undefined,
  warfare: Warfare,
  useFormulas: boolean,
): { plan: Map<string, string>; building: boolean } {
  // Respect gates recruiting and converts to the faction rep we need for The Red Pill. Money
  // only becomes the objective once the roster is full.
  const wantRespect = members.length < MAX_MEMBERS;
  const score = (member: MemberInfo, task: TaskStats): number => {
    if (useFormulas) {
      return wantRespect
        ? ns.formulas.gang.respectGain(info, member, task)
        : ns.formulas.gang.moneyGain(info, member, task);
    }
    return wantRespect ? respectScore(info, member, task) : moneyScore(info, member, task);
  };

  const earning = tasks.filter((task) => task.name !== TASK_WARFARE && task.name !== TASK_VIGILANTE);
  const training = info.isHacking ? TASK_TRAIN_HACKING : TASK_TRAIN_COMBAT;
  const plan = new Map<string, string>();

  const ranked = members
    .map((member) => {
      const best = earning.map((task) => ({ task, value: score(member, task) })).sort((a, b) => b.value - a.value)[0];
      return { member, task: best?.task, value: best?.value ?? 0 };
    })
    .sort((a, b) => b.value - a.value);

  // Earn only once a member can do a HIGH-TIER task; below that, TRAIN — do not settle for mugging.
  // This is the fix for the gang stalling: exp gain scales with difficulty^0.9, so Mug (difficulty 1)
  // builds stats ~63x slower than Train Combat (difficulty 100). A member left mugging earns a
  // trickle but crawls toward the stat wall forever. Training rushes them to where a real task —
  // Terrorism, baseRespect 0.01, ~200x Mug's — goes net-positive, at which point the ranker picks it
  // and respect (hence rep) jumps orders of magnitude. The threshold cleanly separates the top tier
  // (Terrorism/Human Trafficking/Cyberterrorism/Money Laundering) from the low-tier trickle tasks.
  const earners: typeof ranked = [];
  const trainees: typeof ranked = [];
  for (const entry of ranked) {
    const ready = entry.task && entry.value > 0 && entry.task.baseRespect >= EARN_UNLOCK_RESPECT;
    (ready ? earners : trainees).push(entry);
  }
  for (const entry of trainees) plan.set(entry.member.name, training);
  for (const entry of earners) plan.set(entry.member.name, entry.task!.name);

  // Power only accrues from members actually sitting on Territory Warfare. Don't stall recruiting
  // for it, and never send trainees — power is stats/95, so they contribute nothing anyway.
  //
  // Note power is a SUM over the members on the task, never an average, so a weak member can only
  // ADD to the rate — there is no such thing as one "dragging down" the total. The only cost of
  // staffing a weak member is the income they forgo, which for a weak member is negligible too.
  let slots = 0;
  let building = false;
  let garrison = 0;
  if (members.length >= MAX_MEMBERS) {
    if (warfare.engaged) {
      // Two different jobs, and only the first needs the whole roster.
      //
      // BUILDING (power still buying something): more power raises `powerBonus`, which is how much
      // territory each win TAKES. But it is logarithmic — 4.5x the power is +17% territory per clash
      // — so it only pays while the remaining prize is large. And that prize shrinks as we conquer:
      // finishing an hour sooner was worth ~262x income at 17.5% territory, ~67x at 33%, and ~7x by
      // 67%. Past the crossover, staffing the roster costs more than it buys.
      //
      // GARRISON (power only preventing loss): the decay is ~`rivalPower * 0.0159` regardless of our
      // own power, so holding a crushed rival down is a couple of weak members, not twelve. That
      // requirement also falls as territory rises, so the garrison shrinks on its own.
      //
      // At rivalTerritory 0 the war ends itself — `gangs` only lists factions holding territory and
      // the clash block is gated on `gangs.length > 1`, so there is nobody left to fight and no way
      // to lose it back. Everyone earns.
      if (warfare.rivalTerritory > 0) {
        building = true;
        garrison = powerToHold(info.power, warfare.rivalPower, info.territory);
        slots = MAX_MEMBERS;
      }
    } else {
      // Staff warfare only if this roster can actually finish the race. A rival gains ~1.2 power per
      // update no matter what we do, so a roster whose rate can't clear that is strictly worse off
      // trying: it forfeits all income and still never engages. Measured, at POWER_MEMBERS = 4, the
      // gap to Speakers WIDENED. This gate is what makes the whole thing self-enabling — earn, buy
      // augs, stats rise, our rate rises, and warfare switches itself on when it can be won.
      const updates = updatesToChance(
        info.power,
        ourPowerRate(
          info,
          earners.map((entry) => entry.member),
        ),
        warfare.rivalPower,
        warfare.rivalRate,
        CLASH_ENGAGE_FLOOR,
      );
      // `rivalPower > 0` is load-bearing, not a null-check: it means "there is someone left to
      // fight". Without it a zero (a stale/absent port payload, or every rival already crushed) makes
      // updatesToChance return 0 — an instant "eta 0, go" that parks the whole roster on warfare for
      // nothing. Fail safe: no rival data, no blackout.
      building = warfare.rivalPower > 0 && updates * POWER_UPDATE_MS <= POWER_BUILD_MAX_MS;
      slots = building ? POWER_MEMBERS : 0;
    }
  }

  // Weakest earners first: they cost the least income, and since a strong member's power and its
  // earnings scale together, filling a power quota from the bottom is cheaper than from the top.
  // `garrison > 0` caps the draft at whatever holds our power steady; otherwise `slots` takes all.
  const warriors: typeof ranked = [];
  let staffed = 0;
  for (let i = earners.length - 1; i >= 0 && warriors.length < slots; i--) {
    if (garrison > 0 && staffed >= garrison) break;
    warriors.push(earners[i]);
    staffed += memberPower(earners[i].member);
  }
  for (const entry of warriors) plan.set(entry.member.name, TASK_WARFARE);

  // wantedPenalty = respect/(respect+wanted) scales BOTH respect and money, so letting it sag is a
  // flat tax on everything — but Vigilante Justice earns nothing, so it is pure cost. Three guards:
  //
  //  1. Wait for the wanted level to actually rise off its floor of 1. A new gang is at respect 0,
  //     wanted 1, penalty 0 — "below floor" before doing anything. Gating on the ratio alone
  //     deadlocks the gang: all members go vigilante, none earn respect, the ratio never recovers.
  //  2. Skip members whose vigilante statWeight is <= 0 — wantedGain returns 0 for them, so they
  //     would suppress nothing while earning nothing. This is most of the roster early on.
  //  3. Cap the share of earners we're willing to pull off income.
  //
  // wantedGain is exact (its formula carries no softcap exponent), so this is right without
  // Formulas.exe.
  const vigilante = byName(TASK_VIGILANTE);
  if (vigilante && info.wantedLevel > WANTED_LEVEL_FLOOR && info.wantedPenalty < WANTED_PENALTY_FLOOR) {
    const net = (): number =>
      members.reduce((sum, member) => {
        const task = byName(plan.get(member.name) ?? '');
        return sum + (task ? wantedGain(info, member, task) : 0);
      }, 0);
    const spare = earners.filter(
      (entry) => plan.get(entry.member.name) !== TASK_WARFARE && wantedGain(info, entry.member, vigilante) < 0,
    );
    const cap = Math.floor(earners.length * VIGILANTE_MAX_FRACTION);
    let used = 0;
    for (let i = spare.length - 1; i >= 0 && used < cap && net() > 0; i--, used++) {
      plan.set(spare[i].member.name, TASK_VIGILANTE);
    }
  }

  return { plan, building };
}

function status(
  ns: NS,
  info: GangInfo,
  members: MemberInfo[],
  plan: Map<string, string>,
  warfare: Warfare,
  building: boolean,
): void {
  const count = (task: string): number => [...plan.values()].filter((name) => name === task).length;
  // upgrades / augmentations aren't NS API names, so reading them is free; cash costs 0.1 GB.
  const gear = members.reduce((sum, member) => sum + member.upgrades.length, 0);
  const augs = members.reduce((sum, member) => sum + member.augmentations.length, 0);
  const cash = ns.getServerMoneyAvailable('home');
  ns.clearLog();
  ns.print(`gang ${REV} [build ${VERSION}] — ${info.faction} (${info.isHacking ? 'hacking' : 'combat'})`);
  ns.print(`  members   ${plan.size}/${MAX_MEMBERS}`);
  ns.print(`  respect   ${ns.format.number(info.respect)}  (+${ns.format.number(info.respectGainRate)}/cycle)`);
  ns.print(`  money     ${ns.format.number(info.moneyGainRate)}/cycle`);
  // Gang investment: if these counts climb tick-over-tick, equip.js is buying. If cash sits above
  // the reserve while they're stuck, the affordable items are all owned — not a stall.
  ns.print(
    `  invested  ${augs} augs, ${gear} gear owned   (cash ${ns.format.number(cash)}, ` +
      `reserve ${ns.format.number(GANG_CASH_RESERVE)})`,
  );
  // wantedPenalty is the MULTIPLIER on gains (0.9792 = keep 97.92%). The game UI shows it as a
  // reduction (-2.08%); match that so the two read the same. We act when it drops below the floor.
  const reduction = info.wantedPenalty - 1;
  const floored = info.wantedPenalty < WANTED_PENALTY_FLOOR && info.wantedLevel > WANTED_LEVEL_FLOOR;
  ns.print(
    `  wanted    ${ns.format.number(info.wantedLevel)}  gains ${ns.format.percent(reduction)}` +
      ` (floor ${ns.format.percent(WANTED_PENALTY_FLOOR - 1)})${floored ? '  <- vigilante' : ''}`,
  );
  ns.print(
    `  territory ${ns.format.percent(info.territory)}  power ${ns.format.number(info.power)}  ` +
      `${info.territoryWarfareEngaged ? 'CLASHING' : 'peace'} (min win ${ns.format.percent(warfare.minChance)})`,
  );
  // The race, made visible: our power rate must beat the rival's or warfare is a pure loss.
  const rate = ourPowerRate(
    info,
    members.filter((member) => plan.get(member.name) === TASK_WARFARE),
  );
  ns.print(
    `  power/upd ${ns.format.number(rate)} vs rival ${ns.format.number(warfare.rivalRate)}` +
      ` (${ns.format.number(warfare.rivalPower)} pow)`,
  );

  // Two different questions, and only one is meaningful at a time. Before clashing, the number that
  // matters is time to CLASH_ENGAGE_FLOOR ('never' = the roster can't win and the gate is correctly
  // keeping everyone on income). Once clashing, that eta is 0 and says nothing — what matters is how
  // long until the rival's territory is ours. The conquest eta holds the CURRENT win chance and power
  // ratio fixed, both of which improve as the rival's power collapses, so it reads long and arrives
  // early.
  const time = (updates: number): string => (Number.isFinite(updates) ? ns.format.time(updates * POWER_UPDATE_MS) : '');
  if (warfare.engaged) {
    const rush = territoryRate(info.power, warfare.rivalPower);
    const eta = rush > 0 ? warfare.rivalTerritory / rush : Infinity;
    ns.print(
      `  conquest  +${ns.format.percent(rush * 180, 3)}/hr, ${ns.format.percent(warfare.rivalTerritory)} left` +
        ` — ${rush > 0 ? `<= ${time(eta)}` : 'LOSING GROUND'}${building ? '  (roster still building)' : ''}`,
    );
  } else if (building) {
    const eta = updatesToChance(info.power, rate, warfare.rivalPower, warfare.rivalRate, CLASH_ENGAGE_FLOOR);
    ns.print(`  building  to ${ns.format.percent(CLASH_ENGAGE_FLOOR)} win — eta ${time(eta) || 'never'}`);
  }
  const training = count(TASK_TRAIN_COMBAT) + count(TASK_TRAIN_HACKING);
  const parked = training + count(TASK_WARFARE) + count(TASK_VIGILANTE);
  ns.print(
    `  tasks     ${plan.size - parked} earning, ${training} training, ` +
      `${count(TASK_WARFARE)} warfare, ${count(TASK_VIGILANTE)} vigilante`,
  );
}
