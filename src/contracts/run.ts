import type { NS } from '@ns';
import { crawl, rooted } from '../lib/net';
import { VERSION } from '../lib/ports';

/**
 * ~4 GB launcher — fits an 8 GB home. `solve.js` and `test.js` are ~24 GB and cannot run on home,
 * so this finds the rooted host with the most free RAM, copies the target plus its lib deps there,
 * and execs it. Because the build transforms each file separately (no bundling), the imported
 * modules must travel with the entry script.
 *
 *   run /contracts/run.js test              validate every solver against dummy contracts (do first)
 *   run /contracts/run.js solve --dry       solve + report all real contracts, attempt none
 *   run /contracts/run.js solve             attempt all real contracts
 *
 * Any flags after the subcommand are passed straight through to the launched script.
 */
const REV = 'v1';

const DEPS = ['/lib/contracts.js', '/lib/net.js', '/lib/ports.js'];

export async function main(ns: NS) {
  const sub = String(ns.args[0] ?? '');
  if (sub !== 'test' && sub !== 'solve') {
    ns.tprint('ERROR usage: run /contracts/run.js <test|solve> [flags]');
    return;
  }
  const passthrough = ns.args.slice(1);
  const target = `/contracts/${sub}.js`;
  const need = ns.getScriptRam(target, 'home');

  // Pick the rooted host with the most free RAM.
  let best = '';
  let bestFree = -1;
  for (const host of rooted(ns, crawl(ns))) {
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    if (free > bestFree) {
      bestFree = free;
      best = host;
    }
  }

  if (bestFree < need) {
    ns.tprint(
      `ERROR ${target} needs ${need.toFixed(2)} GB; the best rooted host (${best}) has only ` +
        `${bestFree.toFixed(2)} GB free. Buy/upgrade a server, or free up RAM, then retry.`,
    );
    return;
  }

  ns.scp([target, ...DEPS], best);
  const pid = ns.exec(target, best, 1, ...passthrough);
  if (pid === 0) {
    ns.tprint(`ERROR failed to exec ${target} on ${best} (${bestFree.toFixed(2)} GB free, needs ${need.toFixed(2)}).`);
    return;
  }

  ns.ui.openTail(pid);
  ns.tprint(`run ${REV} [build ${VERSION}]: launched ${target} on ${best} (pid ${pid}). Watch its tail for results.`);
}
