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

> **Don't trust this section — run `/probe/state.js` and let the game answer.** It prints the
> BitNode, owned Source-Files, home RAM, gang status and which programs exist. This section claimed
> "BitNode 1, zero Source-Files, 8 GB home" long after that stopped being true and sent planning off
> a cliff. The probe is the authority; everything below is a snapshot with a date on it.

**SF-1.1, SF-2.3, SF-4.3.** BN1 cleared once, BN2 and BN4 cleared three times each.

> Player-reported 2026-07-27, **not** probe output — the Source-File list is trustworthy, everything
> else about the current run (node, home RAM, gang, programs, augs) is UNKNOWN here. Run
> `/probe/state.js` and replace this block with its output before planning against it.

From `Prestige.ts` — starting home RAM on entering a BitNode:

```ts
if (activeSourceFileLvl(9) >= 2) setMaxRam(128);
else if (activeSourceFileLvl(1) > 0) setMaxRam(32);
else setMaxRam(8);
```

- **SF-1.1 means a new BitNode starts at 32 GB home**, not 8. The 8 GB era is behind us.
- **128 GB on entry needs SF-9 level ≥ 2** (Hacknet Servers, BN9), which we do not have — and level 2
  means **two** BN9 clears, not one. Any 128 GB we are sitting on is *purchased upgrades*, and drops
  back to 32 on entering the next BitNode.
- `prestigeAugmentation` does **not** reset home RAM. RAM upgrades survive augment installs and reset
  only on entering a new BitNode.

**SF-2.3 means a gang in any BitNode** — but only BN2 bypasses the -54,000 karma gate
(`bitNodeN === 2`). Everywhere else the gang is founded by the homicide grind in
`singularity/crime.ts`, gated on `strategy.crime.needGang`.

**SF-4.3 means full `ns.singularity` at no RAM penalty.** Program buying, the TOR router / darkweb,
backdoors, faction joining, rep work, augment purchase and install are all automated — that is the
`src/singularity/` stack. Anything in this doc still framed as "manual because no SF-4" is stale.

**Next target: BN5 "Artificial Intelligence", one clear.** Cheapest exit remaining —
`WorldDaemonDifficulty 1.5` → hacking **4500**, against BN4's 9000 and BN2's 15000. The prize is
**SF-5.1**, which grants:

- **Formulas.exe on every prestige.** `Prestige.ts` pushes it from both `prestigeSourceFile` and
  `prestigeAugmentation` when `canAccessBitNodeFeature(5)`. Since programs otherwise die on entering a
  BitNode, this is the difference between `rank-formulas.ts` being dead code that costs $5b per run to
  wake up and it being the permanent path from second zero, with no post-install gap.
- `ns.getBitNodeMultipliers()` — lets `lib/strategy.ts` derive per-node config instead of hardcoding
  `OVERRIDES`.
- **Intelligence**, the one stat that never resets across BitNodes, plus +8% hacking multipliers.

BN5 config already landed: `OVERRIDES[5]` in `lib/strategy.ts` and `BN_DISABLE[5]` in `lib/ports.ts`.

**BN9 was considered and deferred** — it is the node most hostile to this codebase:
`CloudServerLimit: 0` (no purchased servers at all, so `auto-buy.ts` / `buy-servers.ts` /
`lib/cloud.ts` are inert), `HomeComputerRamCost: 5`, `ServerMaxMoney 0.01` × `ScriptHackMoney 0.1`
(daemon income down ~1000×), `HackExpGain: 0.05`. Revisit only after SF-5.

**Until BN5 is cleared, Formulas.exe is still not owned** ($5,000,000,000, or hacking level 1000 to
write). Thread math stays on `rank.ts`'s min-security projection; the daemon execs `rank-formulas.js`
instead the moment the file exists on home.

**Programs do not survive entering a BitNode** — only NUKE.exe carries over, so every run re-buys the
port openers and SQLInject. Anywhere in this doc that calls a program "owned" is describing a *past*
run until `/probe/state.js` says otherwise.

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
| `import { cheap }` from a module that *also* exports a `getServer` caller | 1.60 | named imports are charged **per symbol** |
| a **local variable** named `share` | **4.00** | charged `ns.share`'s 2.4 GB |
| `ns.ramOverride(1.6)` as the first statement | 1.60 | pins the total, ignoring everything else |

> **Imports are followed per *symbol*, not per module.** `RamCalculations.ts` maps each
> `ImportSpecifier` to `module.name` and walks only that symbol's dependency set. So a lib may hold an
> expensive helper next to a cheap one, and `import { cheap }` pays nothing for it. But
> `import * as lib` and default imports add `module.*` and drag in **everything** — never use them for
> a lib that touches a costly API. The module's *top-level* scope is always a dependency, so keep
> costed calls inside functions, never at module level.

> **The naming hazard.** Never name a local variable, parameter, or function after an NS API.
> `const share = ...` costs 2.4 GB. `const scan = ...` costs 0.2. `hack`/`grow`/`weaken` cost
> 0.1/0.15/0.15. `exec` 1.3, `run` 1.0, `getServer` 2.0. Anything named `document` or `window` costs
> **25 GB**. This is multiplied per thread on workers. It bit us once already: a probe named its
> local `const getServer`, silently paid 2 GB, and nearly produced the wrong conclusion.
>
> **It is not just names you choose — it is every property you *read*.** `RamCalculations.ts` walks
> `MemberExpression` into `node.property`, and `findFunc` searches the cost table **recursively by
> bare name**, ignoring namespaces. So reading a field off an NS return value is charged whenever
> that field's name collides with *any* API, at any depth. Measured: `getGangInformation()` returns
> a `respectForNextRecruit` field, and merely reading `info.respectForNextRecruit` bills **1 GB**
> for `ns.gang.respectForNextRecruit()` — a function the script never calls. Likewise `member.hack`
> costs 0.1 GB. (`member.moneyGain` / `.respectGain` / `.wantedPenalty` collide with
> `ns.formulas.gang.*`, which are 0 GB, so those happen to be free.)
>
> **The dodge, when the collision is expensive:** a string-literal bracket access is invisible to
> the parser — `info['respectForNextRecruit']` costs nothing and reads the same plain object, so
> there is no dynamic cost either. Unlike the `ramOverride` tricks below, this is not deferral: no
> NS function is ever called, so nothing is owed. Comment it where you use it, or someone will
> "clean it up" back to dot notation and silently re-add the GB. `run /probe/ram/budget.js` is what
> catches this — it is the only reason we found it.

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

## The automation stack (built)

The ladder above is realized. `run /bootstrap.js` after any reset launches the whole self-driving
machine; measured **~$7.8M/sec** on a mature run. `run /probe/ram/budget.js` verifies every script's
static RAM against its budget.

**Two version numbers, and they answer different questions.** Every persistent script prints both, as
`daemon v1 [build v17]`:

| | Where | Bump when | Answers |
|---|---|---|---|
| `REV` | a local `const` in each script | *that script's* behaviour changes | "which revision of this script is running?" |
| `VERSION` | `lib/ports.ts`, shared | *any* change, anywhere | "did the sync push my code, or is the game running stale code?" |

`VERSION` alone can't tell you a script's revision — it moves when an unrelated file changes. `REV`
alone can't detect a stale sync — it doesn't move when someone else's file changes. Keep both.

- **`bootstrap.ts`** — RAM-adaptive launcher. Starts only the scripts that fit the current home, in
  priority order (daemon → monitor → auto-buy → share), leaving `LAUNCH_HEADROOM` for root's exec.
  On an 8 GB home only the daemon fits; re-run after upgrading home to add the rest. Then exits.
- **`daemon.ts`** — the decoupled batcher. Ticks ~1s; re-dispatches only targets whose previous batch
  finished (polled via `isRunning`), best-value first, from whatever pool RAM is free. Each server runs
  on its **own clock** — fast ones cycle every ~90s, slow ones every ~5min, concurrently; income is the
  sum of each server's rate (the round-based predecessor was ~9× slower, paced by the slowest server).
  Per target: weaken→min, then PREP (grow to max, no hack), then MAINTAIN (hack a slice + grow back);
  grow-bound piles DRAIN (hack-only). Runs `rank` on home when it fits, else a remote pool host — this
  is what makes it work at 8 GB home. Never imports `rank` (its analysis calls would add 3 GB); batch
  maths arrive as a `Target[]` over a free port.
- **`rank.ts`** — the Formulas.exe substitute: projects every server to min security exactly, because
  security enters each formula through one term that cancels in a ratio. Also `growthAnalyze` per
  target for batch grow-thread cost. Ranks by money and xp; writes `Target[]` to the port + a file.
- **`root.ts`** — nukes everything whose port requirement is met. `nuke` checks ports only, never
  hacking level, so ~100 GB is free at skill 1.
- **`auto-buy.ts`** — compounds income into pool RAM via `ns.cloud`, but only while the pool is
  ≥85% utilized, so it stops instead of ballooning. `buy-servers.ts` is the one-shot version;
  both share `lib/cloud.ts`.
- **`share.ts`** — floods idle pool RAM with `share()` for faction rep (`1 + ln(threads)/25`, strongly
  diminishing). Separate 10s loop, NOT in the daemon: `share()` lasts ~10s and would lapse inside a
  minutes-long tick otherwise. Its `cap` (0.6) leaves margin, so it auto-yields RAM back to hacking.
- **`map.ts`** — network audit; BFS the whole tree, report every server's depth/root/why-not-hackable.
- **`monitor.ts`** — `ns.ui.openTail` dashboard.

`lib/ports.ts` holds shared constants: `VERSION`, `HOME_RESERVE` (home RAM kept free for controllers +
transient rank/root execs — home is a measured worker host, not hard-excluded), `HACK_FRACTION`,
`GROW_MULT`, port/file paths.

> **A port is a cross-version interface. Never trust the shape of what you read off one.** Ports are
> global and **persist across script restarts** — killing and relaunching both sides does not clear
> them. So after any change to a payload's schema, the reader starts up and parses the *previous
> version's* payload, written by a helper that is no longer running, until that helper's next turn
> rewrites it. Fields you just added read back `undefined`, and `ns.format.number(undefined)` throws
> a TypeError that kills the controller. Bit us on gang v6: `PORT_GANG` still held v5's
> `{wantPower, engaged, minChance}` after the restart.
>
> Validate every field against a typed fallback rather than casting the parse (`JSON.parse(raw) as T`
> is a lie the compiler cannot catch). And make the defaults **fail safe, not fail open** — the same
> fix surfaced a second bug where a defaulted `rivalPower: 0` made a "time to win" calculation return
> 0, reading as *go now* instead of *no data*.

**Reset ritual:** `run /bootstrap.js`, let the daemon earn, upgrade home RAM, re-run bootstrap as it
grows. Purchased servers do NOT survive an augment install (home RAM does); auto-buy rebuys after.

**Biggest untapped lever:** more targets. Only ~15 servers are hackable at a time; the rest are
level-gated or need `SQLInject.exe` (buy on the darkweb — roots the 29 five-port servers at once). Idle
pool RAM is a symptom of too few targets, not inefficiency.

## `ns.dnet` — the Darknet: verified, and PARKED for this run

New in v3. A second server network layered on the normal one, hidden from `ns.scan`. It constantly
mutates: servers move, restart (killing your scripts), and go offline. Servers are cracked by
**guessing passwords**, not by NUKE + port openers. It is **not** the classic TOR darkweb — that is
still `ns.singularity.purchaseProgram`, and the old `darkweb` server becomes the darknet's entry node
(**16 GB**). Access is gated behind `DarkscapeNavigator.exe` — **$50M** darkweb / **$30M** Chongqing +
a TOR router, purely a money gate (no SF, no BitNode lock, no hacking level). BN1's darknet
money multiplier is **1.0** (full); BN9 is 0.05, BN8 disables it.

> **This whole section was written during BN1 / run #1 and its premises have expired.** Programs do
> not survive entering a BitNode, so `DarkscapeNavigator.exe` ("now owned", below) is gone unless
> re-bought, and `/probe/state.js` confirms **Formulas.exe is not owned** in BN2 run #2. BN2's
> darknet money multiplier is also unverified — the 1.0 figure above is BN1's. The *verdict* below
> probably still holds, but re-derive its premises before acting on it.

**Verdict: don't build for it.** We verified against primary source what the darknet gives that money
*can't* buy, and for *run #1* — money-rich, `Formulas.exe` owned, `SQLInject.exe` trivial, plenty of
RAM, charisma ~80 — the answer is: almost nothing useful. The earlier "caches → cheap port programs /
Formulas.exe" thesis is **dead**; those caches only mattered while programs were expensive. Direct
darknet money, cache money, and the abundant darknet RAM are all redundant now. `promoteStock` is dead
weight without a stock position.

**The only genuinely money-unbuyable prize — and why it still doesn't move us:** six darknet-exclusive
augments, "The Sculptor" set: TheBrokenWings → TheBoots → TheHammer → TheStaff → TheLaw → TheSword.
`factions: []`, `isSpecial: true`, awarded one per completed deep "labyrinth" in that fixed prereq
chain (`src/DarkNet/effects/labyrinth.ts` `getLabAugReward`; `src/Augmentation/Augmentations.ts`).
Their multipliers are self-referential — charisma×, combat×, `dnet_money`×, stasis-link-limit +1,
auth/heartbleed speed +20%. The **only** effect that touches a hacking money run is **TheSword's
hacking ×1.10** (+ company_rep ×1.10), sitting at the *end* of a six-labyrinth grind, and it's an
ordinary installed aug that **wipes on entering the next BitNode** — so it doesn't even bank toward
the clear-BN1-×3 → SF-1.3 plan.

**Reward model, corrected (was wrong before):** the cache pool
(`src/DarkNet/effects/cacheFiles.ts`) is program / stock-market (TIX/WSE) access / stock shares /
clue data-file / coding contract / money — **no "experience" reward type exists**, and **no
darknet action grants intelligence XP**; every XP grant is **charisma** only
(`src/NetscriptFunctions/Darknet.ts`). The programming doc's "caches contain money or experience" line
is not backed by the reward code — treat as flavor. (The int-XP farm hope, the one money-can't-buy
accelerator, does not exist here.)

**When to revisit** (neither is now): a real **stock-trading operation** — then `promoteStock` +
WSE-access caches + `dnet_money` augments form a coherent package — or **BN15**, where the labyrinth
is a documented route to `TheRedPill` (`getLabAugReward` BN15 branch).

RAM note, corrected: the expensive verbs run **on the net**, not home. The 16 GB entry node fits
`setStasisLink` (12 GB) + base, and deeper servers have abundant RAM — so the old "impossible on 8 GB
home" caveat is moot. Other practical facts if we ever do build: `probe()` sees only **directly
connected** servers (spread via `scp`+`exec` hop by hop); instability is zero until >2 darknet servers
are backdoored; `unleashStormSeed()` is a deliberate self-destruct that wipes ~60% of the net (never
call by accident); `openCache` costs karma (inert without gangs). Darknet income is credited under a
`"darknet"` MoneySource — `MoneySource.casino`/`.servers` are unrelated.

Read-only recon lives in `src/probe/dnet.ts` (`run /probe/dnet.js`); it touches nothing that mutates
state.

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
