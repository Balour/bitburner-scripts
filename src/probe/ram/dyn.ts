import type { NS } from '@ns';

/**
 * Deliberately contains NO reference to any costed NS API, so importing it
 * cannot pollute a probe's static RAM cost.
 *
 * Fetches an NS method by a name the static parser cannot constant-fold:
 * `ns.args` is only known at runtime, so no bundler or analyzer sees through it.
 */
export function dynamicMethod<T>(ns: NS, fallback: string): T {
  const key = String(ns.args[0] ?? fallback);
  return (ns as unknown as Record<string, T>)[key];
}
