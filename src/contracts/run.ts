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
const REV = 'v2';

const DEPS = ['/lib/contracts.js', '/lib/net.js', '/lib/ports.js'];

export async function main(ns: NS) {
  const sub = String(ns.args[0] ?? '');
  if (sub !== 'test' && sub !== 'solve') {
    ns.tprint('ERROR usage: run /contracts/run.js <test|solve> [flags]');
    return;
  }
  const passthrough = ns.args.slice(1);
  // Our own flags (parsed by plain string match — 0 GB, no ns.flags). --wait blocks until the launched
  // script actually exits, so a caller that waitPids US transitively waits through the whole remote run.
  // --quiet suppresses tail windows + routine terminal output here AND downstream (forwarded to solve).
  const wait = passthrough.includes('--wait');
  const quiet = passthrough.includes('--quiet');
  // solve/test parse args with a non-permissive ns.flags, which throws on an undeclared flag. --wait is
  // ours (consumed here), so strip it before forwarding; --quiet IS declared downstream, so keep it.
  const forward = passthrough.filter((a) => a !== '--wait');
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
    const msg =
      `${target} needs ${need.toFixed(2)} GB; the best rooted host (${best}) has only ` +
      `${bestFree.toFixed(2)} GB free. Buy/upgrade a server, or free up RAM, then retry.`;
    // Expected/routine when the pool is small (early game, saturated pool). An automated --quiet caller
    // retries on a timer, so don't spam the terminal — its own log carries the skip.
    if (quiet) ns.print(`skip: ${msg}`);
    else ns.tprint(`ERROR ${msg}`);
    return;
  }

  ns.scp([target, ...DEPS], best);
  const pid = ns.exec(target, best, 1, ...forward);
  if (pid === 0) {
    ns.tprint(`ERROR failed to exec ${target} on ${best} (${bestFree.toFixed(2)} GB free, needs ${need.toFixed(2)}).`);
    return;
  }

  if (!quiet) ns.ui.openTail(pid);
  const launched = `run ${REV} [build ${VERSION}]: launched ${target} on ${best} (pid ${pid}).`;
  if (quiet) ns.print(launched);
  else ns.tprint(`${launched} Watch its tail for results.`);

  // --wait: block until the launched script exits, so the pre-install sweep finishes BEFORE the reset.
  if (wait) {
    while (ns.isRunning(pid)) await ns.sleep(500);
    const done = `run ${REV}: ${target} on ${best} (pid ${pid}) finished.`;
    if (quiet) ns.print(done);
    else ns.tprint(done);
  }
}
