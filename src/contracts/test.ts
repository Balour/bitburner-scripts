import type { NS } from '@ns';
import { SOLVERS } from '../lib/contracts';
import { VERSION } from '../lib/ports';

/**
 * ~25 GB — createDummyContract 2 + getContractType 5 + getData 5 + attempt 10 + rm 1 + base. TOO BIG
 * FOR AN 8 GB HOME. Launch with `run /contracts/run.js test`, or `run` directly once home is ≥32 GB.
 *
 * The safety gate. For every contract type the game defines, it generates a DUMMY contract on this
 * host, solves it, and attempts the dummy. Dummies are disposable — a wrong answer costs nothing —
 * and `attempt` returning a reward means the game's REAL validator accepted our answer (value AND
 * format). Prints a PASS / FAIL / ERROR line per type. Run this until every type PASSes before ever
 * pointing solve.js at a real contract. A correct dummy is auto-removed on success; a failed one is
 * rm'd here so repeat runs stay clean.
 */
const REV = 'v1';

type Dispatch = Record<string, (data: unknown) => unknown>;

export async function main(ns: NS) {
  ns.disableLog('ALL');
  ns.ui.openTail();
  ns.print(`contracts-test ${REV} [build ${VERSION}]`);

  const host = ns.getHostname();
  const solvers = SOLVERS as unknown as Dispatch;
  const types = ns.codingcontract.getContractTypes();

  let pass = 0;
  const problems: string[] = [];

  for (const type of [...types].sort()) {
    const file = ns.codingcontract.createDummyContract(type, host);
    if (!file) {
      problems.push(type);
      ns.print(`ERROR ${type} — createDummyContract returned null`);
      continue;
    }

    try {
      const solver = solvers[type];
      if (!solver) {
        problems.push(type);
        ns.print(`ERROR ${type} — no solver registered`);
        ns.rm(file, host);
        continue;
      }

      const answer = solver(ns.codingcontract.getData(file, host));
      const reward = ns.codingcontract.attempt(answer, file, host);
      if (reward) {
        pass++;
        ns.print(`PASS  ${type}`);
      } else {
        problems.push(type);
        ns.print(`FAIL  ${type} — validator rejected the answer`);
        ns.rm(file, host);
      }
    } catch (e) {
      problems.push(type);
      ns.print(`ERROR ${type} — solver threw: ${String(e)}`);
      ns.rm(file, host);
    }
  }

  const total = types.length;
  ns.print('');
  if (problems.length === 0) {
    ns.print(`ALL ${pass}/${total} PASS`);
    ns.tprint(`contracts-test: ALL ${pass}/${total} solvers PASS — safe to run contracts/solve.js.`);
  } else {
    ns.print(`${pass}/${total} PASS; not passing: ${problems.join(', ')}`);
    ns.tprint(`contracts-test: ${pass}/${total} PASS. NOT passing: ${problems.join(', ')}`);
  }
}
