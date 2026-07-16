import type { NS } from '@ns';
import { crawl } from '../lib/net';
import { SOLVERS } from '../lib/contracts';
import { VERSION } from '../lib/ports';

/**
 * ~24 GB — getContractType 5 + getData 5 + attempt 10 + getNumTriesRemaining 2 + crawl 0.25 + ls
 * 0.2 + base. TOO BIG FOR AN 8 GB HOME. Launch it with `run /contracts/run.js solve [flags]`, which
 * scp+execs it onto a big rooted host; or `run` it directly once home is ≥32 GB.
 *
 * Sweeps the network, and for every .cct dispatches getData to the pure solver in lib/contracts and
 * attempts the answer. Solvers are exact ports of the game's own getAnswer, so a correct solver
 * never fails — but validate first with `run /contracts/run.js test`, which proves every solver
 * against dummy contracts at zero risk. A wrong answer consumes a real try and, on the last one,
 * destroys the contract.
 *
 *   --dry             solve and report every contract, but do NOT attempt any (safe preview)
 *   --host <h>        only this host
 *   --file <f>        only this .cct file (implies a single host via --host)
 */
const REV = 'v1';

type Dispatch = Record<string, (data: unknown) => unknown>;

const show = (v: unknown): string => (typeof v === 'bigint' ? v.toString() : JSON.stringify(v));

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.ui.openTail();
  const flags = ns.flags([
    ['dry', false],
    ['host', ''],
    ['file', ''],
  ]);
  const dry = flags.dry as boolean;
  const onlyHost = flags.host as string;
  const onlyFile = flags.file as string;

  ns.print(`contracts-solve ${REV} [build ${VERSION}] ${dry ? '(DRY RUN — no attempts)' : ''}`);

  const solvers = SOLVERS as unknown as Dispatch;

  // Locate the .cct files to work on.
  const jobs: { host: string; file: string }[] = [];
  const hosts = onlyHost ? [onlyHost] : crawl(ns);
  for (const host of hosts) {
    for (const file of ns.ls(host, '.cct')) {
      // ns.ls filters by SUBSTRING, so '.cct' also matches our /data/*.cct.json dumps. Real
      // contracts end in exactly '.cct'.
      if (!file.endsWith('.cct')) continue;
      if (onlyFile && file !== onlyFile) continue;
      jobs.push({ host, file });
    }
  }

  if (jobs.length === 0) {
    ns.print('No contracts found.');
    ns.tprint('contracts-solve: no .cct files found.');
    return;
  }

  let solved = 0;
  let failed = 0;
  let unknown = 0;
  const rewards: string[] = [];

  for (const { host, file } of jobs) {
    const kind = ns.codingcontract.getContractType(file, host);
    const solver = solvers[kind];
    if (!solver) {
      unknown++;
      ns.print(`SKIP  ${host}/${file}  [${kind}]  — no solver`);
      continue;
    }

    let answer: unknown;
    try {
      answer = solver(ns.codingcontract.getData(file, host));
    } catch (e) {
      unknown++;
      ns.print(`ERROR ${host}/${file}  [${kind}]  — solver threw: ${String(e)}`);
      continue;
    }

    if (dry) {
      const tries = ns.codingcontract.getNumTriesRemaining(file, host);
      ns.print(`DRY   ${host}/${file}  [${kind}]  (${tries} tries)  -> ${show(answer)}`);
      continue;
    }

    const reward = ns.codingcontract.attempt(answer, file, host);
    if (reward) {
      solved++;
      rewards.push(reward);
      ns.print(`OK    ${host}/${file}  [${kind}]  -> ${reward}`);
    } else {
      failed++;
      ns.print(`FAIL  ${host}/${file}  [${kind}]  answer=${show(answer)}`);
    }
  }

  if (dry) {
    const solvable = jobs.length - unknown;
    ns.tprint(`contracts-solve DRY: ${solvable}/${jobs.length} solvable, ${unknown} without a solver.`);
    return;
  }

  ns.tprint(
    `contracts-solve: ${solved} solved, ${failed} failed, ${unknown} no-solver, of ${jobs.length} contract(s).`,
  );
  for (const r of rewards) ns.tprint(`  reward: ${r}`);
  if (failed > 0) {
    ns.tprint(`  WARNING: ${failed} attempt(s) failed — run \`contracts/run.js test\` to find the broken solver.`);
  }
}
