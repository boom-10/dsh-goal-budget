# dsh-goal-budget

**A resource budget gate for DeepSeek Harness goals.**

When a goal's token or cost budget runs out, this plugin **blocks the goal** — it does not just show you a number.

```ts
ctx.goals.block(agent, { id, revision }, {
  code: 'budget-exceeded',
  message: 'Goal exceeded its configured tokens budget: 5200 / 100',
})
```

---

## Not another cost dashboard

There are already 40+ DSH plugins that report spend. Every one of them is **read-only**:

| Plugin | ⭐ | What it does |
| --- | --- | --- |
| `@kenz1117/dsh-ui-usage-billing` | 95 | usage billing **dashboard**, sidebar cost metrics |
| `dsh-mimo-quota` | 0 | usage and estimated-spend **views** from session event logs |
| `dsh-credits` | 3 | **track** provider balances, plan quotas, session costs |
| `dsh-composer-balance` | 0 | **display** account balance and estimated session cost |
| `dsh-web-api-balance` | 1 | **shows** API balance and this conversation's spend |

They answer **"how much did I spend?"**. This plugin answers **"should this keep running?"** — and acts on the answer.

That difference is not cosmetic. A display can be wrong and you lose nothing. **An enforcement gate can be wrong and kill work that was about to succeed.** Different problem, different failure modes (see [Failure modes](#failure-modes)).

---

## Why this gap, specifically

Not a guess. The harness ships an automatic continuation driver, and its own README names three things it does *not* do:

> **Round cap, not resource budget** — token, currency, time, and provider quota policies remain independent. Their session events are **not attributed to the goal message** or **mapped into goal blocker codes**.
>
> — `packages/goal/goal-round-driver/README.md`, *Known Limitations and Deferred Work*

That sentence names three missing pieces. This plugin fills two of them:

| Named gap | Status |
| --- | --- |
| session events **not attributed to the goal message** | ✅ done here, keyed by `goalId` + `round` |
| not **mapped into goal blocker codes** | ✅ done here, `code: 'budget-exceeded'` |
| wall-clock budget | ⬜ not implemented yet |

`GoalBlockReason.code` is an open `string` documented as *"chosen by the blocking policy"* — it exists so a policy plugin can name its own condition. Only two codes ship in-tree today (`model-reported`, `round-limit`). This adds `budget-exceeded`.

---

## Set a budget

**Per session, from the chat box** — no restart, no config file:

```
/budget            show the effective budget and what you have used
/budget $5         cap this session at 5 USD
/budget 500k       cap it at 500k tokens
/budget $5 500k    cap both; whichever is reached first wins
/budget off        drop the session override and fall back to the profile default
```

The budget is resolved as **session override ?? profile default**, so a fixed allowance can live in config and a one-off tightening costs one line in the composer.

**Or as a profile default**, for an allowance you always want:

```yaml
- id: dsh-goal-budget
  config:
    budget:
      tokens: 2000000
      costUsd: 5.00
    onExceed: block        # or 'warn' to only log
    warnAtRatio: 0.8
```

Why both layers: a budget is a **runtime decision** — it changes per session — while plugin config is a **deployment decision** read at boot. Putting the budget only in config forces a restart to change something you decide in the moment. `/budget` writes a session-scoped override; config supplies the default.

## Install

```sh
dsh plugin --profile desktop add dsh-goal-budget
```

`dsh plugin` forwards to `pnpm` inside the profile directory, so a git reference works too — useful before an npm release:

```sh
dsh plugin --profile desktop add github:boom-10/dsh-goal-budget
```

When installing from a **local path**, pnpm links the package and warns that `peerDependencies` will not resolve from the target `node_modules`. That warning is expected here: `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are provided by the host at runtime. Use the `file:` protocol if it bothers you.

With no budget configured the plugin loads and idles, and `/budget` is how you set one.

### Pricing

Cost estimation needs unit prices. Defaults are DeepSeek's; override them if yours differ or you use a gateway:

```yaml
    pricing:
      inputPerMillion: 0.15
      outputPerMillion: 0.60
      cacheReadPerMillion: 0.003   # see "Cache pricing" below
```

---

## How it works

### Attribution

Two facts make attribution possible, and only one event carries both.

```ts
// packages/core/session/src/types.ts:355 — spend lands here, keyed by turn
'assistant/message': { turn: number; step: number; usage?: TokenUsage; … }

// packages/core/agent/src/runtime-types.ts:328 — the ONLY event linking a message to a turn
'agent/inbox/claimed'(payload: { agent; message: UserMessage; turn: number }): void
```

`user/message` carries no `turn` — its payload is just a `UserMessage`. Sequencing alone would misread every `agent.inject()` context block as a new round. `agent/inbox/claimed` is the only event that pairs a message with the turn it opens, and `message.source` identifies automatic goal rounds:

```ts
source: { kind: 'goal', goalId, revision, round }   // round > 0 means an automatic round
```

So the chain is:

```
agent/inbox/claimed   source.kind === 'goal'  →  remember turn → { goalId, round }
        ↓
assistant/message     { turn, usage }         →  add to that goal's that round
        ↓
checkBudget()                                 →  over? → ctx.goals.block()
```

Attribution is **rebuilt from the session log**, never stored separately — restarting cannot double-count or reset.

### One number, one source

The pill does not compute cost. It reads it from the same projection the gate uses, so the number you see and the number that blocks can never disagree.

That matters more than it sounds. The correct figure is a **per-record** `max(0, inputTokens − cacheReadTokens)` summed over steps, because a single record's `inputTokens` includes its cache reads — but a session's cache-read total can dwarf its input total (one measured session: 4.87M input against 400M cache reads). Subtracting the two totals instead of per record gives `max(0, negative)` → zero, and the estimate lands 15%+ away from the real number.

Two earlier versions got this wrong in two different ways: one priced all input at the full rate and overstated by ~18%; the next subtracted the totals and understated. Both were caught, and both are asserted against now.

The cost convention is also the reason the projection folds `assistant/message` usage itself rather than exposing raw totals: only the host can run the arithmetic that the gate runs.

### Why `ctx.goals.block()` and not something else

It is the documented policy entry point, and it disarms continuation as part of the same call:

```ts
/**
 * Mark an active goal blocked and disarm it.
 * @param reason - policy-owned stable code and human-readable explanation.
 */
block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView
```

### Mechanisms used

| Purpose | Mechanism | Why this one |
| --- | --- | --- |
| Read spend | `session/event` → `assistant/message` | Durable fact; replays across restarts. `agent/assistant-stream` is presentation data, not a replay source. |
| Attribute to a goal | `agent/inbox/claimed` | The only message↔turn link that exists. |
| Enforce | `ctx.goals.block()` | Documented policy entry point; disarms in the same call. |
| Configuration | `@deepseek-ai/schemastery` `Config` | The profile-level default; validated, not a constant. |
| Per-session control | `ctx.commands.register()` | Budgets are runtime decisions. Same mechanism the official `/goal` command uses. |
| Service access | `inject = ['commands', 'goals', 'sessions', 'agents']` | The first three `goals`/`sessions`/`agents` match the in-tree continuation driver. |

---

## Rejected alternatives

**Using `agent/turn-stopping` to stop runaway turns.** Wrong granularity: a budget is a *goal*-level fact spanning many rounds, while `turn-stopping` is a turn-level hook with no cross-round view. Worse, blocking there leaves the goal `active`, so the continuation driver immediately opens another round — a deadlock, not a stop.

**Letting the model police itself via a tool.** The harness already notes the weakness of self-assessment (*"No independent evaluator — the model-facing goal policy decides when evidence is sufficient"*). Asking the constrained party to enforce its own constraint fails exactly when the budget is exhausted and judgment is worst — and it costs another model call *after* the budget is already gone.

**Building the 44th cost dashboard.** The ecosystem has that covered, and a dashboard cannot stop anything.

**Putting the budget only in plugin config.** The first version did, and it was wrong: config is read at boot, so changing a budget meant editing YAML and restarting — for a value you decide per session. A per-session budget needs a per-session surface, which is why `/budget` exists and config keeps only the default.

---

## Failure modes

Known, with current mitigation and what is still unsolved.

| # | Fails how | Looks like | Mitigation | Still open |
| --- | --- | --- | --- | --- |
| 1 | A turn mixes human and goal messages | human spend billed to the goal; premature block | Strict `source.kind === 'goal'` filter | Mixed-turn spend cannot be split cleanly; a warning records when it happens |
| 2 | Unit prices differ from defaults | cost estimate off; wrong block point | All prices are config; docs state these are estimates | Provider price changes, peak/off-peak, gateway markups are not tracked |
| 3 | State rebuilt after restart | budget resets or doubles | Spend is recomputed from the session log only; nothing is stored separately | Session-format migrations may change field availability |
| 4 | Adapter reports no `usage` | spend silently uncounted | Marked **unattributable** and counted, never guessed; the block message reports the count | A provider that never reports usage **cannot be constrained at all** |
| 5 | Several goals in one session | spend billed to the wrong goal | Filtered by `goalId` | The boundary turn when goals are switched |
| 6 | Race with the continuation driver | a round starts after the block | `block()` disarms in the same call; ledgers cleared on dispose | A round already accepted but not yet run (the unload race the driver's README documents) |
| 7 | A ledger is registered in one structure but not the other | **attribution silently stops working** — no error | Both structures are maintained together and asserted by tests | None known |
| 8 | Startup log invisible at INFO level | plugin looks unloaded | Startup visibility uses `console.log`; alerts use `logger.warn` | Verbosity is not yet configurable |
| 9 | ~~`/budget` override is process-local~~ | ~~a restart returns the session to the profile default~~ | **Fixed**: the override lives in the `goalBudget` projection, folded from the `command/run` events the commands service already writes, so it is rebuilt from the log rather than remembered | — |
| 10 | A budget is blocking a goal, then raised | spend already over the old limit, but nothing re-checks | Setting or clearing a budget clears the blocked marker so the next step re-evaluates | A goal already `blocked` stays blocked until the operator resumes it |

Number 7 is the one to watch: it fails *silently*. So does number 8. Both were found by testing behaviour rather than checking for absence of errors — the same shape as the harness's own post-mortem 0001, where 178 green tests and 100% line coverage coexisted with a completely non-functional feature.

### Cache pricing

At a 90% cache-hit ratio, ignoring `cacheReadTokens` overstates cost by **2.7×** on a measured scenario (1000 input / 900 cached / 100 output). The error is not a fixed multiple — it grows with the hit ratio, and the unit price gap is ~50×. So `cacheReadTokens` is priced separately and subtracted from `inputTokens` to avoid double-billing.

---

## Development

```sh
npm run typecheck   # tsc
npm test            # five specs; no API key needed
npm run build       # esbuild bundle → lib/index.js
```

The suite is checked by mutation, not just by passing: reintroducing either pricing bug, or dropping the `nullable()` a wire view needs, turns it red. Two of those mutations originally survived — the tests had never exercised a `k` suffix or a non-zero `cacheReadTokens` — which is how `accounting.spec.ts` and the suffix cases in `budget-command.spec.ts` came to exist.

Two suites: `test/loader.spec.ts` asserts the export shape through the real `unwrapExports` semantics, and `test/budget-command.spec.ts` drives the `/budget` handler and asserts that a session override actually changes the blocking threshold, that clearing it stops blocking, and that one goal is never blocked twice.

Types for the harness APIs this plugin uses live in [`types/dsh-ambient.d.ts`](types/dsh-ambient.d.ts), each annotated with its source file and line. That file doubles as the dependency manifest — it is the complete list of harness surface this plugin touches, and it costs no install.

`test/loader.spec.ts` drives the real `unwrapExports` semantics rather than mounting the plugin by hand, because a hand-mounted test cannot validate how a plugin loads. It asserts that no `export default` is present: a default export makes the loader resolve to a bare `apply` function, discarding the sibling `inject`/`name`/`Config` exports, so the fiber is built with an empty `inject` and the plugin crashes on first service access.

## License

MIT
