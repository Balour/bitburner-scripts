import type { NS } from '@ns';

/**
 * 12.25 GB — getContractType 5 + getData 5 + scp 0.6 + getHostname 0.05 + base.
 * TOO BIG FOR AN 8 GB HOME. Must be exec'd on a 16 GB rooted server:
 *
 *   run /contracts/inspect.js <host> <file.cct>          (once home is 16 GB)
 *   scp + exec it on foodnstuff / joesguns / ... until then
 *
 * It NEVER calls `attempt`. A wrong answer consumes one of a contract's few
 * tries and destroys it on the last one, so nothing here writes to the game.
 * The dump is for writing solvers offline.
 *
 * Deliberately omits getDescription (another 5 GB): the description is static
 * text per type, and the type name already identifies the puzzle.
 */
export async function main(ns: NS) {
  const host = String(ns.args[0] ?? '');
  const file = String(ns.args[1] ?? '');
  if (!host || !file) {
    ns.tprint('ERROR usage: run /contracts/inspect.js <host> <file.cct>');
    return;
  }

  const kind = ns.codingcontract.getContractType(file, host);
  const data = ns.codingcontract.getData(file, host);

  const out = `/data/cct-${host}-${file}.json`;
  ns.write(out, JSON.stringify({ host, file, kind, data }, null, 2), 'w');
  ns.scp(out, 'home', ns.getHostname());

  ns.tprint('');
  ns.tprint(`=== ${file} on ${host} ===`);
  ns.tprint(`  type: ${kind}`);
  ns.tprint(`  data: ${JSON.stringify(data)}`);
  ns.tprint(`  saved to ${out} on home`);
  ns.tprint('');
}
