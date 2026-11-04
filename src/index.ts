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
import { addUsage, checkBudget, type GoalSpend, type Pricing, type TurnSpend } from './accounting.ts'

export const name = 'dsh-goal-budget'

/** 声明进 inject 的服务 —— 缺一个都会在加载期抛「without inject」。 */
export const inject = ['goals', 'sessions', 'agents'] as const

export const Config = z.object({
  budget: z
    .object({
      /** 累计 token 上限（input+output+reasoning）。0 = 不限制。 */
      tokens: z.number().default(0),
      /** 累计费用上限（美元，按下面的单价估算）。0 = 不限制。 */
      costUsd: z.number().default(0),
    })
    .default({ tokens: 0, costUsd: 0 }),
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
  budget: { tokens: number; costUsd: number }
  pricing: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }
  onExceed: 'block' | 'warn'
  warnAtRatio: number
}

// 编译期校验：schema 推断出的类型必须能赋给手写接口。
// 不一致会在这里报错，而不是等到运行时。
type _SchemaMatchesInterface = Infer<typeof Config> extends GoalBudgetConfig ? true : never
const _check: _SchemaMatchesInterface = true
void _check

type Ctx = {
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
  const budget = config.budget ?? { tokens: 0, costUsd: 0 }
  const pricing: Pricing = config.pricing ?? {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.003,
  }
  const unlimited = (budget.tokens ?? 0) <= 0 && (budget.costUsd ?? 0) <= 0

  // 启动日志。
  //
  // ⚠️ 实测：不能用 `ctx.logger.info` —— headless profile 下 INFO 级到不了 stdout，
  //    插件看起来像没加载（OBSERVED：加了 info 日志后 stdout 里一个字都没有，
  //    换成 console.log 立刻可见）。排障时最怕的就是这种「静默成功」。
  //    所以启动可见性走 console.log，运行期告警走 ctx.logger.warn（warn 级能看到）。
  console.log(
    `[goal-budget] 已加载 · inject=[${inject.join(',')}] · ` +
      (unlimited
        ? '未配置预算，空转中（设置 budget.tokens 或 budget.costUsd 后生效）'
        : `预算 tokens=${budget.tokens ?? 0} costUsd=${budget.costUsd ?? 0} · 超限动作=${config.onExceed}`),
  )

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

  /** ② 累加：usage 挂在 assistant/message 上，且带 turn/step。 */
  ctx.on('session/event', ((session: object, event: { type?: string; data?: unknown }) => {
    if (event?.type !== 'assistant/message') return
    const data = event.data as { turn?: number; usage?: never } | undefined
    const turn = data?.turn
    if (typeof turn !== 'number') return

    for (const l of allLedgers()) {
      const own = l.ownership.get(turn)
      if (!own) continue
      const spend = spendFor(l, own.goalId)
      const prev = spend.rounds.get(own.round) ?? emptyTurn(turn)
      const next = addUsage(prev, data?.usage, pricing)
      spend.rounds.set(own.round, next)
      if (!next.attributable) spend.unattributableTurns += 1
      void session
      evaluate(ctx, l, own.goalId, own.agent, config)
      return
    }
  }) as never)
}

/** 遍历用的活跃账本集合。 */
function allLedgers(): Set<Ledger> {
  return liveLedgers
}

/** ③ 判定 + 阻断。 */
function evaluate(ctx: Ctx, l: Ledger, goalId: string, agent: object, config: GoalBudgetConfig): void {
  const spend = l.byGoal.get(goalId)
  if (!spend) return
  const verdict = checkBudget(spend, config.budget ?? {})

  // 告警档位（去重）
  const warnAt = config.warnAtRatio ?? 0
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

  const message =
    `Goal exceeded its configured ${verdict.kind} budget: ` +
    `${verdict.used.toFixed(verdict.kind === 'costUsd' ? 6 : 0)} / ${verdict.limit}` +
    (spend.unattributableTurns > 0
      ? ` (${spend.unattributableTurns} turn(s) reported no usage and are not counted)`
      : '')

  if (config.onExceed === 'warn') {
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
