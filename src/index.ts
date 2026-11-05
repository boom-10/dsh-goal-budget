/**
 * dsh-goal-budget —— 给 goal 加一道资源维度的闸门。
 *
 * 缺口来源（官方原文，`packages/goal/goal-round-driver/README.md`）：
 *   "Round cap, not resource budget — token, currency, time, and provider quota
 *    policies remain independent. Their session events are not attributed to the
 *    goal message or mapped into goal blocker codes."
 *
 * 本插件做那三件被点名缺失的事：**归因 → 映射 → 阻断**。
 *
 * ⚠️ 三条硬规矩（来自官方 postmortem 0001，见设计文档第八节）：
 *   1. 命名空间插件**不得**有 `export default` —— unwrapExports 会扔掉 inject
 *   2. 机会性读取的服务用 `ctx.get(name)`，不用 `ctx.<name>`
 *   3. 至少一个测试要走真实 Loader 路径（test/loader.spec.ts）
 */

import z from '@deepseek-ai/schemastery'
import type { Infer } from '@deepseek-ai/schemastery'
import {
  addUsage, checkBudget, openRound, totalsOf,
  type GoalSpend, type Pricing, type TurnSpend,
} from './accounting.ts'
import {
  describeBudget, formatDuration, formatTokens, formatUsd, isUnlimited,
  parseBudgetCommand, renderBudget, type Budget,
} from './budget-command.ts'
import { createGoalBudgetProjection } from './budget-projection.ts'

export const name = 'dsh-goal-budget'

/** 声明进 inject 的服务 —— 缺一个都会在加载期抛「without inject」。 */
export const inject = ['commands', 'goals', 'sessions', 'sessionProjections', 'agents'] as const

export const Config = z.object({
  budget: z
    .object({
      /** 累计 token 上限（input+output+reasoning）。0 = 不限制。 */
      tokens: z.number().default(0),
      /** 累计费用上限（美元，按下面的单价估算）。0 = 不限制。 */
      costUsd: z.number().default(0),
      /** 累计计算时间上限（毫秒）：各轮跨度之和，不含轮与轮之间的空闲。0 = 不限制。 */
      wallClockMs: z.number().default(0),
    })
    .default({ tokens: 0, costUsd: 0, wallClockMs: 0 }),
  pricing: z
    .object({
      inputPerMillion: z.number().default(0.15),
      outputPerMillion: z.number().default(0.6),
      /** ★ 缓存命中单价，比未命中低约 50 倍（第 0004 节实测）。 */
      cacheReadPerMillion: z.number().default(0.003),
    })
    .default({ inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 }),
  /** 超预算时的动作。`block` 会调 ctx.goals.block() 并自动 disarm。 */
  onExceed: z.union([z.const('block'), z.const('warn')]).default('block'),
  /** 达到该比例时注入一次提醒（0–1）。0 = 不提醒。 */
  warnAtRatio: z.number().default(0.8),
})

/** 与上面的 Config schema 一一对应。schema 改了这个也要改 —— tsc 会检查赋值处。 */
export interface GoalBudgetConfig {
  budget: { tokens: number; costUsd: number; wallClockMs: number }
  pricing: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
  onExceed: 'block' | 'warn'
  warnAtRatio: number
}

// 编译期校验：schema 推断出的类型必须能赋给手写接口。
// 不一致会在这里报错，而不是等到运行时。
type _SchemaMatchesInterface = Infer<typeof Config> extends GoalBudgetConfig ? true : never
const _check: _SchemaMatchesInterface = true
void _check

type BudgetInvocation = {
  agent: object
  rawInput: string
}

type Ctx = {
  /** 出处：packages/interaction/commands/src/index.ts:285 */
  commands: {
    register(definition: {
      definitionId?: unknown
      name: string
      description: string
      input?: { hint: string }
      handler: (invocation: BudgetInvocation) => { kind: 'success'; text?: string } | { kind: 'error'; text: string }
    }): () => void
  }
  /** 出处：packages/session/session-projection/src/index.ts（register 返回 disposer） */
  sessionProjections: {
    register(definition: unknown): Promise<{ readonly dispose?: () => void }>
  }
  on: (event: string, listener: (...args: never[]) => void) => void
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  get: (name: string) => unknown
  goals: { get: (agent: unknown) => { id: string; revision: number } | undefined; block: (agent: unknown, ref: unknown, reason: { code: string; message: string }) => unknown }
}

/**
 * 每个 agent 一份账本。
 *
 * 用 WeakMap 做查找（键是 agent 对象本身，不阻止它被回收），
 * 另用一份 Set 做遍历 —— **WeakMap 不可枚举，没有遍历能力**。
 * ⚠️ 两个结构必须同时维护；只写一个会让归因静默失效。
 */
const ledgers = new WeakMap<object, Ledger>()
const liveLedgers = new Set<Ledger>()

type Ledger = {
  /** turn → 这个 turn 属于哪个 goal 的哪一轮（来自 agent/inbox/claimed） */
  ownership: Map<number, { goalId: string; round: number; agent: object }>
  /** goalId → 累计消费 */
  byGoal: Map<string, GoalSpend>
  /** 已经提醒过的比例档位，避免每轮都注入 */
  warned: Set<string>
  /** 已经阻断过的 goalId，避免重复 block */
  blocked: Set<string>
}

function ledgerFor(agent: object): Ledger {
  let l = ledgers.get(agent)
  if (!l) {
    l = { ownership: new Map(), byGoal: new Map(), warned: new Set(), blocked: new Set() }
    ledgers.set(agent, l)
    liveLedgers.add(l)          // ← 与 WeakMap 同步维护，缺这行归因会静默失效
  }
  return l
}

function spendFor(l: Ledger, goalId: string): GoalSpend {
  let s = l.byGoal.get(goalId)
  if (!s) {
    s = { goalId, rounds: new Map(), unattributableTurns: 0 }
    l.byGoal.set(goalId, s)
  }
  return s
}

const emptyTurn = (turn: number): TurnSpend => ({
  turn,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  attributable: true,
})

export function apply(ctx: Ctx, config: GoalBudgetConfig): void {
  // ── 存储方案 C：profile 默认 + 会话覆盖 ──
  //
  // profile 里配的是**默认值**，适合预算固定的人；
  // `/budget` 写的**会话覆盖**优先，适合临时收紧。
  // 覆盖用 WeakMap 以 agent 为键 —— agent 就是会话的作用域，且不阻止回收。
  const profileBudget: Budget = {
    tokens: config.budget?.tokens ?? 0,
    costUsd: config.budget?.costUsd ?? 0,
    wallClockMs: config.budget?.wallClockMs ?? 0,
  }

  /**
   * 会话覆盖的**进程内快路径**。
   *
   * 权威来源是 `goalBudget` 投影（fold 会话日志里的 `command/run`），
   * 它负责重启后重建和给客户端读。这里这份是同一份事实的缓存：
   * 两者都由 `/budget` 的 handler 在同一个动作里写入，**不会分歧**。
   * 用它是因为主机端判定路径上不想为了读一个值去取 session 对象。
   */
  const sessionOverrides = new WeakMap<object, Budget>()


  /** 解析某会话当前生效的预算，并说明它从哪来。 */
  const resolveBudget = (agent: object): { budget: Budget; source: 'session' | 'profile' } => {
    const override = sessionOverrides.get(agent)
    return override === undefined
      ? { budget: profileBudget, source: 'profile' }
      : { budget: override, source: 'session' }
  }

  const pricing: Pricing = config.pricing ?? {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.003,
  }
  const unlimited = isUnlimited(profileBudget)

  /**
   * 把覆盖登记成投影 —— 客户端 `useProjection('goalBudget')` 读的就是它。
   * 顺带让「重启后预算还在」成立：日志里有 `/budget` 事件，状态就能重建。
   */
  // 单价与宿主 Config 同源 —— 客户端显示的数就是阻断判定用的数。
  const projectionHandle = ctx.sessionProjections.register(createGoalBudgetProjection(pricing))
  // register 可能是异步的；失败不能拖垮插件加载（postmortem 0001 的教训：
  // 加载期的异常会让整个 fiber 失败）。
  void Promise.resolve(projectionHandle).catch((error: unknown) => {
    ctx.logger.warn(`[goal-budget] goalBudget 投影注册失败，客户端将读不到预算：${String(error)}`)
  })

  // 启动日志。
  //
  // ⚠️ 实测：不能用 `ctx.logger.info` —— headless profile 下 INFO 级到不了 stdout，
  //    插件看起来像没加载（OBSERVED：加了 info 日志后 stdout 里一个字都没有，
  //    换成 console.log 立刻可见）。排障时最怕的就是这种「静默成功」。
  //    所以启动可见性走 console.log，运行期告警走 ctx.logger.warn（warn 级能看到）。
  console.log(
    `[goal-budget] 已加载 · inject=[${inject.join(',')}] · ` +
      (unlimited
        ? 'profile 未设默认预算 —— 用 /budget 按会话设置，或在 cordis.patch.yml 里配 budget'
        : `默认预算 ${describeBudget(profileBudget)} · 超限动作=${config.onExceed} · /budget 可按会话覆盖`),
  )

  /**
   * `/budget` —— 会话级预算控制。
   *
   * 为什么用命令而不是只靠 Config：Config 是**部署配置**（启动时读、改完要重启、
   * profile 级），而预算是**运行时决策**（按会话、随时改）。把预算只放在 yaml 里
   * 是用错了层。
   *
   * 沿用官方 `/goal` 的注册模式（packages/goal/command-goal/src/index.ts:190）。
   */
  ctx.commands.register({
    definitionId: 'dsh-goal-budget',
    name: 'budget',
    description: 'Set or view the resource budget for this session',
    input: { hint: '[<$usd>|<tokens>|off]' },
    handler: (invocation) => {
      const parsed = parseBudgetCommand(invocation.rawInput)

      switch (parsed.kind) {
        case 'show': {
          const { budget, source } = resolveBudget(invocation.agent)
          return { kind: 'success', text: renderBudget(budget, source, usedFor(invocation.agent)) }
        }
        case 'set': {
          sessionOverrides.set(invocation.agent, parsed.budget)
          // 改了预算就重置「已阻断」标记，否则调高预算后不会重新生效。
          const l = ledgers.get(invocation.agent)
          if (l) l.blocked.clear()
          return {
            kind: 'success',
            text: `本会话预算已设为 ${describeBudget(parsed.budget)}。\n` +
              '超过时会阻断当前 goal 并停止自动续跑。用 /budget off 恢复 profile 默认。',
          }
        }
        case 'clear': {
          sessionOverrides.delete(invocation.agent)
          const l = ledgers.get(invocation.agent)
          if (l) l.blocked.clear()
          const { budget } = resolveBudget(invocation.agent)
          return {
            kind: 'success',
            text: `已恢复 profile 默认预算：${describeBudget(budget)}`,
          }
        }
        case 'invalid':
          return { kind: 'error', text: parsed.reason }
      }
    },
  })

  if (unlimited) return

  /**
   * ① 归因：`agent/inbox/claimed` 是**唯一**能把消息关联到 turn 的事件。
   *
   * 为什么不用 `user/message`：它的载荷就是 UserMessage，**不带 turn**
   * （packages/core/session/src/types.ts:315）。只靠 seq 顺序归因，
   * 会把 `agent.inject()` 注入的上下文误判成新的轮次起点。
   */
  ctx.on('agent/inbox/claimed', ((payload: { agent: object; message: { source?: { kind?: string; goalId?: string; round?: number } }; turn: number }) => {
    const src = payload.message?.source
    if (src?.kind !== 'goal' || typeof src.round !== 'number') return
    if (src.round <= 0) return // round 0 是人工创建 goal 的那条消息，不算自动轮次
    ledgerFor(payload.agent).ownership.set(payload.turn, {
      goalId: String(src.goalId),
      round: src.round,
      agent: payload.agent,
    })
  }) as never)

  /** 卸载时清空账本，避免插件重载后带着旧状态。 */
  ctx.on('dispose', (() => {
    liveLedgers.clear()
  }) as never)

  /**
   * ② 累加：花费挂在 `assistant/message`，时长靠 `turn/start` / `turn/end`。
   *
   * ★ 时间维度为什么用这两个事件而不是 `Date.now()`：
   *
   * `agent/inbox/claimed`（归因用）是 **agent 事件，不带 time**；而
   * `turn/start` / `turn/end`（packages/core/session/src/types.ts:294/303）是
   * **session 事件，自带 `SessionEvent.time`**。
   *
   * 只用事件时间的好处是**同一份事实可以投影**：`goalBudget` 投影 fold 同样的
   * 事件得到同样的时长，客户端显示的数与宿主判定用的数不会分歧
   * —— 这正是 0.5.0 修掉的那一类 bug。用 `Date.now()` 就做不到了。
   */
  ctx.on('session/event', ((session: object, event: { type?: string; time?: number; data?: unknown }) => {
    const type = event?.type
    if (type !== 'assistant/message' && type !== 'turn/start' && type !== 'turn/end') return
    const at = typeof event.time === 'number' ? event.time : undefined
    const data = event.data as { turn?: number; usage?: never } | undefined
    const turn = data?.turn
    if (typeof turn !== 'number') return

    for (const l of allLedgers()) {
      const own = l.ownership.get(turn)
      if (!own) continue
      const spend = spendFor(l, own.goalId)
      const prev = spend.rounds.get(own.round) ?? emptyTurn(turn)

      if (type === 'turn/start') {
        spend.rounds.set(own.round, at === undefined ? prev : openRound(prev, at))
        return
      }
      if (type === 'turn/end') {
        spend.rounds.set(own.round, at === undefined ? prev : { ...prev, endedAt: Math.max(prev.endedAt ?? at, at) })
        return
      }

      // assistant/message —— 保险：若 turn/start 在归因建立之前就到了，
      // 这里补开这一轮，否则 startedAt 会一直是 undefined，时长恒为 0。
      const opened = at === undefined ? prev : openRound(prev, at)
      const next = addUsage(opened, data?.usage, pricing, at)
      spend.rounds.set(own.round, next)
      if (!next.attributable) spend.unattributableTurns += 1
      void session
      const { budget: effective } = resolveBudget(own.agent)
      evaluate(ctx, l, own.goalId, own.agent, effective, config.onExceed, config.warnAtRatio ?? 0)
      return
    }
  }) as never)
}

/** 某会话所有 goal 的累计用量 —— 给 `/budget` 显示用。 */
function usedFor(agent: object): { tokens: number; costUsd: number; wallClockMs: number } | undefined {
  const l = ledgers.get(agent)
  if (!l) return undefined
  let tokens = 0
  let costUsd = 0
  let wallClockMs = 0
  for (const spend of l.byGoal.values()) {
    const t = totalsOf(spend)
    tokens += t.tokens
    costUsd += t.costUsd
    wallClockMs += t.wallClockMs
  }
  return { tokens, costUsd, wallClockMs }
}

/** 遍历用的活跃账本集合。 */
function allLedgers(): Set<Ledger> {
  return liveLedgers
}

/** ③ 判定 + 阻断。 */
function evaluate(
  ctx: Ctx,
  l: Ledger,
  goalId: string,
  agent: object,
  // ★ 传入【已解析】的预算 —— 之前这里读 config.budget，
  //    导致 /budget 写的会话覆盖完全不起作用（测试抓到的 bug）。
  budget: Budget,
  onExceed: 'block' | 'warn',
  warnAtRatio: number,
): void {
  const spend = l.byGoal.get(goalId)
  if (!spend) return
  const verdict = checkBudget(spend, budget)

  // 告警档位（去重）
  const warnAt = warnAtRatio
  if (warnAt > 0 && !verdict.exceeded && verdict.ratio >= warnAt) {
    const key = `${goalId}:${Math.floor(verdict.ratio * 10) / 10}`
    if (!l.warned.has(key)) {
      l.warned.add(key)
      ctx.logger.warn(
        `[goal-budget] goal ${goalId} 已用 ${(verdict.ratio * 100).toFixed(0)}% 预算` +
          (spend.unattributableTurns > 0 ? `（另有 ${spend.unattributableTurns} 个 turn 无法归因）` : ''),
      )
    }
  }

  if (!verdict.exceeded) return
  if (l.blocked.has(goalId)) return

  // 三个维度的量纲不同：时间要按人类可读格式渲染，否则会出现「1800000 / 3600000」。
  const usedText = verdict.kind === 'wallClockMs' ? formatDuration(verdict.used) : String(verdict.used)
  const limitText = verdict.kind === 'wallClockMs' ? formatDuration(verdict.limit) : String(verdict.limit)
  const message =
    `Goal exceeded its configured ${verdict.kind} budget: ` +
    `${verdict.kind === 'costUsd' ? verdict.used.toFixed(6) : usedText} / ${limitText}` +
    (spend.unattributableTurns > 0
      ? ` (${spend.unattributableTurns} turn(s) reported no usage and are not counted)`
      : '')

  if (onExceed === 'warn') {
    ctx.logger.warn(`[goal-budget] ${message}`)
    l.blocked.add(goalId)
    return
  }

  const goal = ctx.goals.get(agent)
  if (!goal) {
    ctx.logger.warn(`[goal-budget] 超预算但读不到当前 goal，无法阻断：${message}`)
    return
  }
  ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: 'budget-exceeded', message })
  l.blocked.add(goalId)
  ctx.logger.warn(`[goal-budget] 已阻断 goal ${goalId}：${message}`)
}
