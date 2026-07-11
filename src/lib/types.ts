/**
 * Types only — no imports, no NS calls. The whole module is erased at build
 * time, so importing it costs 0 GB. Keep it that way.
 */

/** One rooted, money-bearing server, projected to its min-security state. */
export interface Target {
  host: string;
  maxMoney: number;
  reqSkill: number;
  baseSec: number;
  minSec: number;
  /** Security when rank last measured. */
  curSec: number;
  /** Fraction of `maxMoney` a single hack thread takes, at min security. */
  pctAtMin: number;
  /** Probability a hack succeeds, at min security. */
  chanceAtMin: number;
  /** Milliseconds, at min security. Grow is 3.2x, weaken is 4x. */
  hackTimeAtMin: number;
  /** $/sec per hack thread on a fully-prepped server. 0 if unhackable now. */
  moneyScore: number;
  /** Hacking exp/sec per grow thread. Never 0 — grow has no level gate. */
  xpScore: number;
  /** Threads to grow one BATCH_FRACTION hack back to max, from growthAnalyze.
   * Accurate when rank measured at min security; a mild over-estimate otherwise
   * (higher security needs more threads), which is safe — grow caps at max. */
  growThreads: number;
}
