import type { NS } from '@ns';
import type { GangInfo, MemberInfo, TaskStats } from './lib/gang';
import {
  GANG_CASH_RESERVE,
  EARN_UNLOCK_RESPECT,
  MAX_MEMBERS,
  POWER_MAINTAIN,
  POWER_MEMBERS,
  TASK_IDLE,
  TASK_TRAIN_COMBAT,
  TASK_TRAIN_HACKING,
  TASK_VIGILANTE,
  TASK_WARFARE,
  VIGILANTE_MAX_FRACTION,
  WANTED_LEVEL_FLOOR,
  WANTED_PENALTY_FLOOR,
  moneyScore,
  respectScore,
  wantedGain,
} from './lib/gang';
import { PORT_GANG, VERSION } from './lib/ports';

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
 * respect-priority was keeping members weak and stalling the whole gang below the stat wall. */
const REV = 'v5';

const HELPERS = ['/gang/ascend.js', '/gang/equip.js', '/gang/territory.js'];
/** Ticks between helper launches. One at a time, so peak RAM stays bounded. */
const HELPER_EVERY = 5;
const TICK_MS = 2000; // the gang itself only processes every 2s
const BONUS_TICK_MS = 200; // burn down bonus time faster when the game hands us some

interface Warfare {
  wantPower: boolean;
  engaged: boolean;
  minChance: number;
}

function readWarfare(ns: NS): Warfare {
  const raw = ns.peek(PORT_GANG);
  if (typeof raw !== 'string' || raw.startsWith('NULL')) {
    return { wantPower: false, engaged: false, minChance: 0 };
  }
  return JSON.parse(raw) as Warfare;
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
    const plan = assign(ns, info, members, tasks, byName, warfare, useFormulas);

    for (const member of members) {
      const task = plan.get(member.name);
      if (task && member.task !== task) ns.gang.setMemberTask(member.name, task);
    }

    if (tick % HELPER_EVERY === 0) {
      const helper = HELPERS[Math.floor(tick / HELPER_EVERY) % HELPERS.length];
      ns.exec(helper, 'home');
    }

    status(ns, info, members, plan, warfare);

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
): Map<string, string> {
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
  let slots = 0;
  if (members.length >= MAX_MEMBERS) {
    slots = warfare.engaged ? POWER_MAINTAIN : warfare.wantPower ? POWER_MEMBERS : 0;
  }
  const warriors = earners.slice(Math.max(0, earners.length - slots));
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

  return plan;
}

function status(ns: NS, info: GangInfo, members: MemberInfo[], plan: Map<string, string>, warfare: Warfare): void {
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
  const training = count(TASK_TRAIN_COMBAT) + count(TASK_TRAIN_HACKING);
  const parked = training + count(TASK_WARFARE) + count(TASK_VIGILANTE);
  ns.print(
    `  tasks     ${plan.size - parked} earning, ${training} training, ` +
      `${count(TASK_WARFARE)} warfare, ${count(TASK_VIGILANTE)} vigilante`,
  );
}
