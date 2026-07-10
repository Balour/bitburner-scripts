import type { NS } from '@ns';

/**
 * The documented saving: a script that statically pays for `getServer` (3.6 GB)
 * but knows it will not call it this run, and hands the RAM back.
 *
 * Run: `run /probe/ram/override-down.js`
 *
 * If `ramOverride(1.6)` returns 1.6, overriding down works and is the real lever.
 * Then we attempt the call anyway, which must now fail — proving the game
 * enforces the lowered ceiling rather than merely relabelling it.
 */
export async function main(ns: NS) {
  ns.tprint(`static allocation: ${ns.ramOverride()} GB (expect 3.60 — getServer is referenced below)`);

  const lowered = ns.ramOverride(1.6);
  ns.tprint(`after ramOverride(1.6): ${lowered} GB  ${lowered === 1.6 ? '(lowered — RAM handed back)' : '(REFUSED)'}`);

  try {
    // Statically visible, so it is counted, yet we just gave the RAM back.
    const server = ns.getServer('home');
    ns.tprint(`CALL SUCCEEDED after lowering -> ${server.hostname}  (ceiling NOT enforced)`);
  } catch (e) {
    ns.tprint(`CALL THREW after lowering -> ${e}  (ceiling enforced, as expected)`);
  }
}
