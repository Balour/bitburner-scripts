# bitburner-scripts

Game scripts, written in TypeScript and synced live into Bitburner. Everything under `src/` is
uploaded; `src/foo.ts` lands in-game as `/foo.js`.

## `@ns` is the only authority

`NetscriptDefinitions.d.ts` (aliased `@ns`) is **downloaded from the running game** on connect. It is
gitignored and does not exist until you connect once. It describes *this* game version exactly.

**Trust it over the changelog, the wiki, and your own training data.** Pre-v3 Bitburner knowledge is
stale and confidently wrong. Grep the file before claiming an API exists.

## Bitburner v3 broke the API

v3.0.0 (2 May 2026). There are **zero `@deprecated` tags** — v3 *removed* old APIs rather than
deprecating them, so breakage is a hard `is not a function`, never a warning.

| Old | New |
|---|---|
| `ns.formatNumber`, `ns.formatRam`, `ns.formatPercent`, `ns.nFormat`, `ns.tFormat` | **`ns.format.number/.ram/.percent/.time`** |
| `ns.getPurchasedServers`, `ns.purchaseServer`, `ns.deleteServer`, `ns.getPurchasedServerCost`, `ns.getPurchasedServerMaxRam` | **`ns.cloud.getServerNames/.purchaseServer/.deleteServer/.getServerCost/.getRamLimit`** (+ `getServerLimit`) |
| `ns.tail` | **`ns.ui.openTail`** |
| `ns.getTimeSinceLastAug` | removed — use `ns.getResetInfo().lastAugReset` |
| `ns.gang.getOtherGangInformation` | `ns.gang.getAllGangInformation` |

Other v3 changes:

- **NS1 is gone.** `.script` files do not run. Everything is `.js`/`.ts`.
- **`nuke` and the port openers return `false` on failure instead of throwing.** Code relying on
  `try/catch` for failure silently changes control flow.
- **`RunOptions.preventDuplicates` now defaults to `false`.** Identical `ns.exec` calls are no longer
  rejected, so the old `Math.random()` de-dupe argument is obsolete.
- **Exact enum strings required** — fuzzy matching removed. Prefer `ns.enums.*` over string literals.
- `ns.hack/grow/weaken` and most `getServer*` take an **optional** host (defaults to current server).
- New namespaces: `ns.cloud`, `ns.format`, `ns.dnet`.
- `ns.flags` gotcha: a flag whose default is `null`/`undefined` parses as a **string**, so
  `--bar false` yields the truthy string `"false"`. Give flags real typed defaults.

## Where we actually are

**BitNode 1, zero Source-Files.** This is the constraint that shapes everything.

From `Prestige.ts` — starting home RAM on entering a BitNode:

```ts
if (activeSourceFileLvl(9) >= 2) setMaxRam(128);
else if (activeSourceFileLvl(1) > 0) setMaxRam(32);
else setMaxRam(8);
```

- **Run #1 (now): 8 GB home.** Not 32.
- **Runs #2–3: 32 GB home**, once SF-1 exists at any level.
- **128 GB requires SF-9 level ≥ 2** (Hacknet Servers, BitNode 9) — *not* from repeating BN1.
- Plan is to clear BN1 three times → **SF-1.3 = +28% to all multipliers**.
- `prestigeAugmentation` does **not** reset home RAM. RAM upgrades survive augment installs and reset
  only on entering a new BitNode.

**No SF-4 means no `ns.singularity`.** So in run #1 there is *no* automating: buying port programs,
the TOR router / darkweb (`purchaseTor`, `purchaseProgram`, `getDarkwebPrograms` are all Singularity),
backdoors, faction joining, or augment installs. Those are manual. Legacy `program-buyer.ts` and
`backdoor-all.ts` are dead code for us.

**Formulas.exe costs $5,000,000,000** (or hacking level 1000 to write). Not happening early. Until
then, thread math must be done without `ns.formulas.*`.

## RAM is the whole game

Base cost is **1.6 GB per script**, before a single API call. Total is `perThread × threads`.

| Cheap | GB | Expensive | GB |
|---|---|---|---|
| `hack` | 0.10 | `getServer` | **2.0** |
| `grow` / `weaken` | 0.15 | `share` | 2.4 |
| port openers, `nuke`, `hasRootAccess` | 0.05 | `spawn` | 2.0 |
| `getServerMaxRam` / `UsedRam` | 0.05 | every `*Analyze` | **1.0** each |
| `getHack/Grow/WeakenTime` | 0.05 | `exec` | 1.3 |
| `getServerMoneyAvailable` / `MaxMoney` / `SecurityLevel` / `MinSecurityLevel` | 0.10 | `run`, `scriptRunning`, `getResetInfo` | 1.0 |
| `scan`, `ps` | 0.20 | `scp` | 0.6 |

**Free (0 GB):** `sleep`, `asleep`, `ramOverride`, `flags`, `getScriptName`, all `ns.format.*`, and
every port-handle method (`read`/`write`/`peek`/`nextWrite`/`tryWrite`/...).

> **Cardinal rule.** Workers run at high thread counts. Never import analysis or logging helpers into
> `hack.ts`/`grow.ts`/`weaken.ts` — use **type-only** imports (`import type { NS } from '@ns'`) so
> nothing is pulled in at runtime. One stray `getServer` adds 2 GB *per thread*.

Concrete worker costs: `hack` 1.70 GB, `grow` 1.75 GB, `weaken` 1.75 GB.

At 8 GB home, `getServer` (2 GB) and the `*Analyze` family (1 GB each) are effectively unaffordable.
Prefer the 0.05–0.1 GB `getServer*` scalar getters and compute thread counts by hand.

### Static vs dynamic RAM — all of this is verified in-game

Probe scripts live in `src/probe/ram/`. `run /probe/ram/report.js` reprints the table below from the
live game; the others demonstrate the runtime behaviour. Re-run them after any game update.

**The static parser (`src/Script/RamCalculations.ts`) harvests every bare identifier name** in the
module and matches it against the RAM cost table. It never checks that the name was reached through
`ns`. Measured:

| pattern | GB | rule |
|---|---|---|
| nothing | 1.60 | base cost of any script |
| `ns.getServer(...)` inside `if (false)`-style dead code | 3.60 | **dead references still cost** |
| `ns['getServer']` | 1.60 | literal bracket access is **invisible** |
| `ns[key]`, key from `ns.args` | 1.60 | dynamic access is **invisible** |
| `getServer` reached only via `import` | 3.60 | **imports are followed** |
| a **local variable** named `share` | **4.00** | charged `ns.share`'s 2.4 GB |
| `ns.ramOverride(1.6)` as the first statement | 1.60 | pins the total, ignoring everything else |

> **The naming hazard.** Never name a local variable, parameter, or function after an NS API.
> `const share = ...` costs 2.4 GB. `const scan = ...` costs 0.2. `hack`/`grow`/`weaken` cost
> 0.1/0.15/0.15. `exec` 1.3, `run` 1.0, `getServer` 2.0. Anything named `document` or `window` costs
> **25 GB**. This is multiplied per thread on workers. It bit us once already: a probe named its
> local `const getServer`, silently paid 2 GB, and nearly produced the wrong conclusion.

**The dynamic check kills you.** `dynamicRamUsage` accumulates the true cost of each distinct NS
function actually called. The moment it exceeds the reservation, the game calls `killWorkerScript`
and throws. The thrown value is a *string*, so `catch` runs — but `stopFlag` is already set, so the
next `ns` call dies with an uncatchable `ScriptDeath`. Observed: `call-dynamic.js` prints one line
and vanishes mid-`try`. **Treat it as fatal.**

**`dynamicRamUsage` is monotonic.** `ramOverride` (0 GB) may:

- **raise** the reservation, if the server has the free RAM. Then a dynamically-accessed function
  becomes callable — you pay real RAM at that moment.
- **lower** it, but never below what you have already spent. Observed: after raising 1.6 → 4 and
  calling `getServer`, `ramOverride(1.6)` was refused and returned **4** (refusal returns the current
  allocation). Lowering to 3.6 — the high-water mark — would have worked.

**So RAM dodging does not make calls free.** Pinning static RAM low only defers the reservation; the
call still costs, and if the server lacks the RAM at that instant, `ramOverride` refuses and the
subsequent call kills the script.

**The one real dodge is the helper-script pattern.** Each script's RAM is calculated and enforced
independently. A tiny helper pays for the expensive call in *its own* process and returns the result
over a port. The caller pays only `exec` (1.3 GB) or `run` (1.0 GB) — **all port I/O is free**. This
is how a lean controller reads `getServer` data without ever paying 2 GB itself.

## Strategy

Hybrid, per the player's design: a small **bootstrap** script detects the stage of the game, launches
the appropriate strategy, and kills itself. Detect at runtime (`ns.getResetInfo()` gives
`currentNode`, `ownedSF`, `bitNodeOptions`; `ns.fileExists('Formulas.exe','home')`); don't hardcode.

The ladder, roughly:

1. **8 GB, no programs.** One target, simple loop: weaken to min, grow to max, hack a slice, repeat.
   Distribute plain workers across whatever the network lets us root. No batching, no analysis calls.
2. **More RAM + more port programs.** Distributed HWGW batches, thread math computed by hand, targets
   ranked by money/sec.
3. **Purchased servers (`ns.cloud`) + Formulas.exe.** Full continuous batcher with exact thread math.

Player's stated preferences:

- **No `share()`** unless faction rep is an explicit goal. Money first. (Note: `share()` does *not*
  raise security — it only boosts faction reputation gain, at 2.4 GB. It's skipped because that RAM
  buys `grow`/`hack` threads instead.)
- **Hack fraction is tunable, not fixed.** Legacy hardcoded 10% steal; revisit per stage.
- **No home RAM reservation.** Manual play costs no RAM.
- Other subsystems (hacknet, stocks, gang, corp, bladeburner, sleeves, stanek) are out of reach early
  but wanted eventually. Which one matters depends on the BitNode — e.g. where hacking is throttled,
  Bladeburner is a second route to completing the node.

## `ns.dnet` — the Darknet: real, lucrative, and NOT early

New in v3. A second server network layered on the normal one, hidden from `ns.scan`. It constantly
mutates: servers move, restart (killing your scripts), and go offline. Servers are cracked by
**guessing passwords**, not by NUKE + port openers. It is **not** the classic TOR darkweb — that is
still `ns.singularity.purchaseProgram`, and the old `darkweb` server becomes the darknet's entry node.

**Gated behind `DarkscapeNavigator.exe`.** Confirmed in-game:
`"You do not have access to the dnet api. Purchase \"DarkscapeNavigator.exe\" through your TOR router."`
It costs **$50M** on the darkweb, or **$30M** at a location in Chongqing, plus a TOR router (~$200k).
No Source-File, no BitNode lock, no hacking level — the gate is purely money, so it *is* reachable
without Singularity. BN1's darknet money multiplier is **1.0** (full); BN9 is 0.05, BN8 disables it.

**Do not build for it in run #1's early game.** Access needs $50M you don't have, and everything that
makes it pay scales with **charisma, which starts at 1**. Early `phishingAttack` is ~5% success,
~10 s per attempt, ~$50 payout — a charisma trainer, not income.

**Worth returning to mid-run**, because caches are the prize: clearing a server's blocked RAM
(`memoryReallocation`) drops a `.cache`, and `openCache` rolls one reward from ~5 categories — money
(**~$10M at difficulty 0**, ×1.2 per difficulty), **free port programs, even Formulas.exe** (else
$5B), stock-market access, or coding contracts. For a no-Singularity BN1 run where programs are
bought by hand, that is a serious shortcut.

Practical notes: `probe()` only sees servers **directly connected** to the server the script runs on,
so spreading means `scp`+`exec` hop by hop. The expensive verbs are meant to run **on darknet
servers**, which have abundant RAM — `setStasisLink` is 12 GB and `induceServerMigration` 4 GB, both
impossible on an 8 GB home. Instability is zero until you backdoor more than 2 darknet servers.
`unleashStormSeed()` is a deliberate self-destruct that wipes ~60% of the net — never call it by
accident. `openCache` costs karma, which is inert without gangs.

Read-only recon lives in `src/probe/dnet.ts` (`run /probe/dnet.js`); it touches nothing that mutates
state. Correction to an earlier guess: `MoneySource.casino`/`.servers` are **unrelated** to the
darknet, whose income is credited under a `"darknet"` source.

## Legacy scripts (`../legacy_scripts/`)

Reference only, pre-v3, not synced. Two competing hacking systems:

- `Hacking/batch/` — the real one: a ~730-line continuous HWGW controller, `calculator.ts` (correct
  thread math), `analyzer.ts` (target ranking).
- `Hacking/simple_batch/` — **abandoned draft; ignore.** Hardcoded thread counts, and the deployer
  copies `simple_batch/*` then executes `batch/*`, launching files it never copied.

**Salvage:** `rooter.ts` (`tryRoot`), `connect.ts` (`connectToServers`, a BFS network walk — the
de-facto backbone), `batch/calculator.ts`'s HWGW thread math, and the lean worker scripts.

**Do not copy:**
- The controller tracks batch completion by **wall-clock estimate only** (`Date.now() + getWeakenTime`),
  never re-checks money/security, and allows up to 50 overlapping batches per target. It desyncs under
  contention. A rewrite needs real verification and per-target serialization.
- `server-utils.getAvailableHosts()` roots servers as a side effect of a "get".
- `logger.ts` writes to `ns.tprint`, flooding the terminal. Use `ns.print` + `ns.ui.openTail`.
- Mixed `@ns` and brittle `'../../NetscriptDefinitions'` relative imports.

Everything touching `ns.formatNumber`/`formatRam` or the `ns.getPurchasedServer*` family is broken on
v3; nearly every utility touches the latter.

## Conventions

- Workers: `import type { NS } from '@ns';` — type-only, always.
- Entry point: `export async function main(ns: NS) { ... }`.
