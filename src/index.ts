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
  addUsage, checkBudget, openRound, totalsOf, UNPRICED,
  type GoalSpend, type Pricing, type TurnSpend,
} from './accounting.ts'
import { detectAccountCurrency, type CredentialsService } from './currency-detect.ts'
import { bandFor, calendarCovers, ratesFor, resolvePriceKey, type Band, type ConfiguredPrice, type Currency, type ModelAliases } from './tariff.ts'
import {
  describeBudget, formatDuration, formatTokens, formatUsd, isUnlimited,
  parseBudgetCommand, renderBudget, type Budget,
} from './budget-command.ts'
import { createGoalBudgetProjection, type GoalBudgetState } from './budget-projection.ts'

export const name = 'dsh-goal-budget'

/** 声明进 inject 的服务 —— 缺一个都会在加载期抛「without inject」。 */
export const inject = ['commands', 'goals', 'sessions', 'sessionProjections', 'agents'] as const

export const Config = z.object({
  budget: z
    .object({
      /** 累计 token 上限（输入含缓存命中，加输出：与宿主「用量」口径一致）。0 = 不限制。 */
      tokens: z.number().default(0),
      /** 累计费用上限，单位为账户币种（见 currency）。0 = 不限制。 */
      costUsd: z.number().default(0),
      /** 累计计算时间上限（毫秒）：各轮跨度之和，不含轮与轮之间的空闲。0 = 不限制。 */
      wallClockMs: z.number().default(0),
    })
    .default({ tokens: 0, costUsd: 0, wallClockMs: 0 }),
  /**
   * 账户币种。`auto` 用 DeepSeek 余额接口识别（只对官方线路有效）；网关线路请直接指定 USD 或 CNY。
   * 价目是 DeepSeek 官方的，按这个币种选用：美元账户用美元价，人民币账户用人民币价。
   */
  currency: z.union([z.const('auto'), z.const('USD'), z.const('CNY')]).default('auto'),
  /** 凭据服务里 DeepSeek API Key 的引用名（与 DeepSeek 路由使用的名字一致）。 */
  deepseekCredentialRef: z.string().default('DEEPSEEK_API_KEY'),
  /**
   * 模型别名：日志里的模型名 → 计价模型。网关给模型加前缀或改名时用。
   * 例：`cm-ais/deepseek-v5-flash: deepseek-flash`。
   * 插件已内置官方名、官方旧名，以及「去掉 `供应商/` 前缀」的匹配，多数网关无需配置。
   */
  modelAliases: z.dict(z.union([z.const('deepseek-flash'), z.const('deepseek-v4-pro')])).default({}),
  /**
   * 是否按 DeepSeek 官方的峰谷时段计价（北京时间周一至周五 9–12、14–18 为高峰，单价 2 倍）。
   *
   * 官方线路为 true。**网关线路通常为 false**：实测某网关 197 条 deepseek 记录全部落在高峰时段，
   * 收费却与非高峰价逐条精确吻合（见 README「用网关账单校准」）。设错会让高峰时段高估一倍。
   */
  peakPricing: z.boolean().default(true),
  /**
   * DeepSeek 之外的模型单价。本项目只内置官方 DeepSeek 价目，其它模型在这里配置。
   *
   * 可靠来源是**供应商自己的账单**：`scripts/calibrate-prices.py` 从网关的逐条计费记录
   * 反解出这四个单价并用残差验证（实测：gpt-6.1-sol 精确解得 2 / 0.1 / 10）。
   * 只配了某个币种时，其它币种的账户会把该模型标为未计价，而不是拿别的币种的价去顶。
   */
  modelPrices: z
    .array(
      z.object({
        model: z.string(),
        currency: z.union([z.const('USD'), z.const('CNY')]),
        inputPerMillion: z.number(),
        cacheReadPerMillion: z.number(),
        cacheWritePerMillion: z.number(),
        outputPerMillion: z.number(),
        /** 该单价是估算（供应商按请求变价）时设 true，面板会用 ≈ 标出。 */
        estimated: z.boolean().default(false),
      }),
    )
    .default([]),
  /** 超预算时的动作。`block` 会调 ctx.goals.block() 并自动 disarm。 */
  onExceed: z.union([z.const('block'), z.const('warn')]).default('block'),
  /** 达到该比例时注入一次提醒（0–1）。0 = 不提醒。 */
  warnAtRatio: z.number().default(0.8),
})

/** 与上面的 Config schema 一一对应。schema 改了这个也要改 —— tsc 会检查赋值处。 */
export interface GoalBudgetConfig {
  budget: { tokens: number; costUsd: number; wallClockMs: number }
  currency: 'auto' | Currency
  deepseekCredentialRef: string
  modelAliases: ModelAliases
  peakPricing: boolean
  modelPrices: readonly ConfiguredPrice[]
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

/**
 * 投影注册句柄。`stateOf` 是**同步**的（session-projection/src/index.ts:60），
 * 所以宿主判定路径上可以直接读，不需要 await。
 */
type ProjectionHandle = {
  readonly dispose?: () => void
  stateOf?(session: object): GoalBudgetState | undefined
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
  /** 出处：packages/session/session-projection/src/index.ts:438 —— 句柄带同步的 stateOf。 */
  sessionProjections: {
    register(definition: unknown): Promise<ProjectionHandle>
  }
  on: (event: string, listener: (...args: never[]) => void) => void
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  get: (name: string) => unknown
  goals: { get: (agent: unknown) => { id: string; revision: number; phase: 'active' | 'paused' | 'blocked' | 'complete' } | undefined; block: (agent: unknown, ref: unknown, reason: { code: string; message: string }) => unknown }
}

/**
 * 每个 agent 一份账本。
 *
 * 用 WeakMap 做查找（键是 agent 对象本身，不阻止它被回收），
 * 另用一份 Set 做遍历 —— **WeakMap 不可枚举，没有遍历能力**。
 * ⚠️ 两个结构必须同时维护；只写一个会让归因静默失效。
 */
const ledgers = new WeakMap<object, Ledger>()
/**
 * 会话 → (turn → 归属)。
 *
 * ★ 必须按**会话**隔离：`turn` 号只在会话内唯一，两个会话同时进行时会重复。
 *   OBSERVED（0.9.2 修）：原先的归属表挂在每个账本上、事件处理时**遍历所有账本**按 turn 匹配，
 *   谁先命中就算谁的 —— 于是 B 会话的花费被记到 A 会话的目标上，A 的预算可能被提前阻断，
 *   而 B 自己的预算永远看不到自己的用量。对一个以归因为卖点的插件，这是硬伤。
 */
const ownershipBySession = new WeakMap<object, Map<number, { goalId: string; round: number; agent: object }>>()
/** 每个会话当前请求头的路由（provider、model）：计价按它查模型的单价。 */
const routeBySession = new WeakMap<object, { provider?: string; model?: string }>()

/**
 * 子代理（subagent）的用量该记到哪个 goal。
 *
 * ★ 为什么需要这张表（OBSERVED，0.10.3 修）：子代理跑在**自己的会话**里，
 *   它的 `assistant/message` 用量不会出现在父会话的日志中 —— 实测本仓库作者的
 *   6 个子代理共 28,170,632 token，父会话账本里为 0，金额与 token 双双漏计。
 *   而 `subagent/catalog`（父会话自己的事件，带 `childId` 与 `childCreatedAt`）
 *   恰好给出了补上这段归因所需的两个信息。
 *
 * 键是子会话 id：子代理的事件带着它自己的 session 对象进来，用 `session.id` 反查。
 */
const childOwnerBySessionId = new Map<string, { goalId: string; round: number; agent: object; createdAt: number }>()

/**
 * 每个会话最近一次见到的 turn。
 *
 * `subagent/catalog` **不带 turn**，所以无法直接知道是哪一轮派生的；用同一会话上
 * 最近一个带 turn 的事件来定位。取不到就宁可不归因（见下面 catalog 分支）。
 */
const lastTurnBySession = new WeakMap<object, number>()

type Ledger = {
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
    l = { byGoal: new Map(), warned: new Set(), blocked: new Set() }
    ledgers.set(agent, l)
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

/**
 * 子代理用量的哨兵轮号：它不属于本会话的任何一轮。
 *
 * 只是 `TurnSpend.turn` 这个必填字段的占位值 —— 汇总存在 `GoalSpend.children` 里，
 * 不进 `rounds`（否则用户看到的轮数会虚增，时长也会被重复相加）。
 */
const CHILD_TURN = -1

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

  // 币种：配置写死，或由 DeepSeek 余额接口识别（异步）。识别完成前，费用暂不计入。
  let currency: Currency | undefined = config.currency === 'auto' ? undefined : config.currency
  if (config.currency === 'auto') {
    void detectAccountCurrency(ctx.get?.('credentials') as CredentialsService | undefined, config.deepseekCredentialRef).then(
      (detected) => {
        if (detected === undefined) {
          ctx.logger.warn('[goal-budget] 没能从 DeepSeek 余额接口识别账户币种，费用暂不计入；请在配置里设置 currency（USD 或 CNY）')
          return
        }
        currency = detected
        console.log(`[goal-budget] DeepSeek 账户币种：${detected}`)
      },
      (error: unknown) => {
        ctx.logger.warn(`[goal-budget] 币种识别失败，费用暂不计入：${String(error)}`)
      },
    )
  }
  if (!calendarCovers(Date.now())) {
    ctx.logger.warn('[goal-budget] 节假日日历不覆盖当前年份，假期的峰谷判断不准确；请运行 scripts/build-holidays.py 更新')
  }
  const unlimited = isUnlimited(profileBudget)

  /**
   * 把覆盖登记成投影 —— 客户端 `useProjection('goalBudget')` 读的就是它。
   * 顺带让「重启后预算还在」成立：日志里有 `/budget` 事件，状态就能重建。
   */
  // 单价与宿主 Config 同源 —— 客户端显示的数就是阻断判定用的数。
  let projection: ProjectionHandle | undefined
  void Promise.resolve(ctx.sessionProjections.register(createGoalBudgetProjection({ currency: () => currency, aliases: config.modelAliases, peakPricing: config.peakPricing, prices: config.modelPrices }))).then(
    (handle) => {
      projection = handle
    },
    // register 可能是异步的；失败不能拖垮插件加载（postmortem 0001 的教训：
    // 加载期的异常会让整个 fiber 失败）。
    (error: unknown) => {
      ctx.logger.warn(`[goal-budget] goalBudget 投影注册失败，客户端将读不到预算：${String(error)}`)
    },
  )

  /**
   * 本会话当前的路由。
   *
   * 优先用本进程看到的 `request/header`。没有时（插件在会话中途加载、或重启后模型没变，
   * 宿主不会再收到新的请求头）退回**投影**读 —— 投影 fold 了整份日志，包含插件加载之前的
   * 请求头。不这么做的话，重启后的花费会被当成不计价，费用维度的闸门静默失效（失败模式 #13）。
   */
  const routeOf = (session: object): { provider?: string; model?: string } | undefined => {
    const seen = routeBySession.get(session)
    if (seen !== undefined) return seen
    const fromLog = projection?.stateOf?.(session)?.route
    if (fromLog === undefined || fromLog === null) return undefined
    routeBySession.set(session, fromLog)
    return fromLog
  }

  /**
   * 按「会话当前路由 + 事件时间」取单价。
   *
   * ★ 父会话与子代理两条记账路径共用这一个函数：计价规则若各写一份，
   *   迟早只改一处（0.5.0 客户端与宿主各算一遍的同类错误）。
   * 峰谷只对内置 DeepSeek 价目有意义；配置单价表的模型按固定价（见 README 校准一节）。
   */
  const pricingFor = (session: object, at: number | undefined): Pricing | undefined => {
    const model = resolvePriceKey(routeOf(session)?.model, config.modelAliases, config.modelPrices)
    if (model === undefined || currency === undefined || at === undefined) return undefined
    const band: Band = model === 'deepseek-flash' || model === 'deepseek-v4-pro'
      ? bandFor(at, config.peakPricing)
      : 'offPeak'
    return pricingOf(model, currency, band, config.modelPrices)
  }

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
          if (
            parsed.budget.costUsd > 0 && parsed.budget.costCurrency !== undefined &&
            currency !== undefined && parsed.budget.costCurrency !== currency
          ) {
            const symbol = currency === 'CNY' ? '¥' : '$'
            return { kind: 'error', text: `本会话的账户币种是 ${currency}，费用上限请用 ${symbol} 设定（例如 /budget ${symbol}${currency === 'CNY' ? '30' : '5'}）。` }
          }
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

  // ★ 不因为「profile 没设默认预算」就跳过监听器注册。
  //
  // OBSERVED（0.9.1 修）：这里原本是 `if (unlimited) return`，于是只用 /budget 设置预算的会话
  // —— 也就是文档主推的用法 —— 命令会成功、pill 也会显示数字（投影在 return 之前已注册），
  // 但用量**完全没记账**，预警与阻断永远不会触发。这是最糟的一类缺陷：看起来一切正常。
  // 预算可以在运行时随时加上，所以监听器必须无条件注册。

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
    // 归属按「会话 + turn」登记。拿不到会话宁可**不归因**，也不能记到别的会话头上。
    const session = (payload.agent as { session?: object }).session
    if (session === undefined) {
      ctx.logger.warn('[goal-budget] 这条 goal 消息取不到所属会话，本轮用量不会记账')
      return
    }
    let owners = ownershipBySession.get(session)
    if (owners === undefined) {
      owners = new Map()
      ownershipBySession.set(session, owners)
    }
    owners.set(payload.turn, { goalId: String(src.goalId), round: src.round, agent: payload.agent })
    ledgerFor(payload.agent)
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
    if (event?.type === 'request/header') {
      const cfg = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined)?.header?.config
      routeBySession.set(session, {
        provider: typeof cfg?.provider === 'string' ? cfg.provider : undefined,
        model: typeof cfg?.model === 'string' ? cfg.model : undefined,
      })
      return
    }
    const type = event?.type
    const at = typeof event.time === 'number' ? event.time : undefined

    // ── 子代理目录（父会话自己的事件）：记下「谁被派生、何时派生」 ──
    //
    // DSH 在派生处发 `subagent/catalog`，带 `childId` 与 `childCreatedAt`。
    // 修复 Agent 级预算所需的两个信息，这里都有了。
    if (type === 'subagent/catalog') {
      const d = event.data as { childId?: unknown; childCreatedAt?: unknown } | undefined
      if (typeof d?.childId !== 'string' || typeof d?.childCreatedAt !== 'number') return
      // catalog 不带 turn：用本会话最近一个带 turn 的事件定位是**哪一轮**派生的。
      const lastTurn = lastTurnBySession.get(session)
      const owner = lastTurn === undefined ? undefined : ownershipBySession.get(session)?.get(lastTurn)
      if (owner === undefined) {
        ctx.logger.warn(`[goal-budget] 子代理 ${d.childId} 定位不到所属轮次，它的用量不会计入本目标`)
        return
      }
      childOwnerBySessionId.set(d.childId, {
        goalId: owner.goalId, round: owner.round, agent: owner.agent, createdAt: d.childCreatedAt,
      })
      return
    }

    if (type !== 'assistant/message' && type !== 'turn/start' && type !== 'turn/end') return
    const data = event.data as { turn?: number; usage?: never } | undefined
    const turn = data?.turn
    if (typeof turn !== 'number') return
    lastTurnBySession.set(session, turn)

    // ── 子代理会话：它花的钱记到派生它的那个目标上 ──
    //
    // ★ 关键是 `at < childCreatedAt` 这个条件：子会话的日志**包含继承自父会话的整段历史**
    //   （实测某个子代理 1474 条 usage 是继承的，只有 15 条是它自己产生的）。
    //   不按创建时刻切分，就会把父会话的历史重复计一遍。
    const childOwner = childOwnerBySessionId.get((session as { id?: string }).id ?? '')
    if (childOwner !== undefined) {
      // 子代理不贡献时长：它跑在父会话那一轮**之内**（见 GoalSpend.children）。
      if (type !== 'assistant/message' || at === undefined || at < childOwner.createdAt) return
      const childLedger = ledgerFor(childOwner.agent)
      const childSpend = spendFor(childLedger, childOwner.goalId)
      const childPricing = pricingFor(session, at)
      if (childPricing === undefined) childSpend.unpricedTurns = (childSpend.unpricedTurns ?? 0) + 1
      childSpend.children = addUsage(childSpend.children ?? emptyTurn(CHILD_TURN), data?.usage, childPricing ?? UNPRICED, at)
      const { budget: childBudget } = resolveBudget(childOwner.agent)
      evaluate(ctx, childLedger, childOwner.goalId, childOwner.agent, costInCurrency(childBudget, currency), config.onExceed, config.warnAtRatio ?? 0)
      return
    }

    // 归属按 (会话, turn) 查 —— 不跨会话扫描（见 ownershipBySession 的说明）。
    const owned = ownershipBySession.get(session)?.get(turn)
    if (owned === undefined) return
    const l = ledgerFor(owned.agent)
    {
      const own = owned
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
      const pricing = pricingFor(session, at)
      if (pricing === undefined) spend.unpricedTurns = (spend.unpricedTurns ?? 0) + 1
      const next = addUsage(opened, data?.usage, pricing ?? UNPRICED, at)
      spend.rounds.set(own.round, next)
      if (!next.attributable) spend.unattributableTurns += 1
      const { budget: effective } = resolveBudget(own.agent)
      evaluate(ctx, l, own.goalId, own.agent, costInCurrency(effective, currency), config.onExceed, config.warnAtRatio ?? 0)
      return
    }
  }) as never)
}

/**
 * 费用上限只对账户币种有效：币种不符，或尚未识别时，费用维度不参与判定（token 与时间照常）。
 * 没有标明币种的上限（profile 默认）按账户币种理解。
 */
function costInCurrency(b: Budget, currency: Currency | undefined): Budget {
  if (b.costUsd <= 0 || b.costCurrency === undefined) return b
  return currency !== undefined && b.costCurrency === currency ? b : { ...b, costUsd: 0 }
}

/**
 * 计价键 → addUsage 的单价形状。
 *
 * 现有会计层是三桶（未命中 / 缓存命中 / 输出），四桶由调用方在此折算：
 * 缓存写入按未命中价并入输入（DeepSeek 不单独收写入费；配置型模型若写入价不同，
 * 需要会计层也扩成四桶 —— 目前账单实测的模型写入量都很小，先按未命中价处理）。
 */
function pricingOf(key: string, currency: Currency, band: Band, prices: readonly ConfiguredPrice[]): Pricing | undefined {
  const r = ratesFor(key, currency, band, prices)
  if (r === undefined) return undefined
  return { inputPerMillion: r.cacheMiss, outputPerMillion: r.output, cacheReadPerMillion: r.cacheHit }
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
  // block() 只接受 active 的 goal。用户可能刚暂停或完成了它，这时它已经不在运行，
  // 不再阻断。这里不记入 blocked：它恢复 active 后，下一次事件仍会正确判定。
  if (goal.phase !== 'active') {
    ctx.logger.warn(`[goal-budget] 超预算，但 goal ${goalId} 当前是 ${goal.phase}，本次不阻断`)
    return
  }
  try {
    ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: 'budget-exceeded', message })
  } catch (error) {
    // revision 已变（比如用户刚编辑过 goal）时 block() 会抛错。不让它冒泡到事件回调里；
    // 不记入 blocked，下一次事件会用最新的 goal 重试。
    const reason = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[goal-budget] 阻断 goal ${goalId} 失败：${reason}`)
    return
  }
  l.blocked.add(goalId)
  ctx.logger.warn(`[goal-budget] 已阻断 goal ${goalId}：${message}`)
}
