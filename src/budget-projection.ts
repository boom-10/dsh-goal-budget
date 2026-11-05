/**
 * 会话的资源状态投影 —— 上限（/budget）与实际花费（assistant/message 的 usage）。
 *
 * 状态只记 token 桶（按模型与峰谷时段分开），不记金额：金额要等账户币种确定后才能算。
 * 币种不在会话日志里，所以金额在读取时由当前币种与官方价目算出。
 * 峰谷时段由每条用量的事件时间决定，历史用量不会因为币种识别得晚而算错时段。
 */
import { z } from 'zod'
import { billedTokensOf, type TokenUsage } from './accounting.ts'
import { parseBudgetCommand } from './budget-command.ts'
import { OFF_DAYS } from './holiday-calendar.ts'
import { bandFor, canonicalDeepSeekModel, costOfTariff, digestOf, ratesFor, type Band, type CanonicalModel, type Currency, type ModelAliases } from './tariff.ts'

/** 客户端读到的形状。 */
export interface GoalBudgetView {
  readonly budget: { readonly tokens: number; readonly costUsd: number; readonly costCurrency: Currency | null } | null
  readonly spent: {
    readonly tokens: number
    /** 费用，单位见 currency。currency 为 null（尚未识别账户币种）时为 0。 */
    readonly costUsd: number
    readonly currency: Currency | null
    readonly unbilledTurns: number
    /** 不能计价的模型名（`provider/model`）。 */
    readonly unpricedModels: readonly string[]
    /** 分模型明细：让「哪部分算了钱、哪部分没算」一眼可见。 */
    readonly models: readonly {
      readonly model: string
      readonly tokens: number
      readonly costUsd: number
      readonly priced: boolean
    }[]
  }
}

/** 一个（模型, 峰谷时段）的 token 桶。 */
export interface Bucket {
  readonly model: CanonicalModel
  readonly band: Band
  readonly uncached: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

/** 投影状态：视图加上当前路由与 token 桶。路由与桶不送给客户端。 */
export interface GoalBudgetState {
  readonly budget: GoalBudgetView['budget']
  readonly route: { readonly provider: string | undefined; readonly model: string | undefined } | null
  readonly tokens: number
  readonly unbilledTurns: number
  /** 不能计价的（模型名, token 数）；token 计入总量，费用不计。 */
  readonly unpriced: readonly { readonly key: string; readonly tokens: number }[]
  readonly buckets: readonly Bucket[]
}

const currencySchema = z.enum(['USD', 'CNY'])
const budgetSchema = z.object({
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  costCurrency: z.nullable(currencySchema),
}).strict()
const bucketSchema = z.object({
  model: z.enum(['deepseek-flash', 'deepseek-v4-pro']),
  band: z.enum(['peak', 'offPeak']),
  uncached: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative(),
}).strict()
const routeSchema = z.object({ provider: z.string().optional(), model: z.string().optional() }).strict()
const stateSchema = z.object({
  budget: z.nullable(budgetSchema),
  route: z.nullable(routeSchema),
  tokens: z.number().nonnegative(),
  unbilledTurns: z.number().int().nonnegative(),
  unpriced: z.array(z.object({ key: z.string(), tokens: z.number().nonnegative() }).strict()),
  buckets: z.array(bucketSchema),
}).strict()
const viewSchema = z.object({
  budget: z.nullable(budgetSchema),
  spent: z.object({
    tokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    currency: z.nullable(currencySchema),
    unbilledTurns: z.number().int().nonnegative(),
    unpricedModels: z.array(z.string()),
    models: z.array(z.object({
      model: z.string(),
      tokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
      priced: z.boolean(),
    }).strict()),
  }).strict(),
}).strict()

const EMPTY: GoalBudgetState = { budget: null, route: null, tokens: 0, unbilledTurns: 0, unpriced: [], buckets: [] }

/** 累加某个不计价模型的 token 数；按键排序，同一份日志得到同一个数组。 */
function addUnpriced(
  list: readonly { key: string; tokens: number }[],
  key: string,
  tokens: number,
): readonly { key: string; tokens: number }[] {
  if (!list.some(u => u.key === key)) return [...list, { key, tokens }].sort((a, b) => (a.key < b.key ? -1 : 1))
  return list.map(u => (u.key === key ? { key: u.key, tokens: u.tokens + tokens } : u))
}

function routeKey(route: GoalBudgetState['route']): string {
  return `${route?.provider ?? 'unknown-provider'}/${route?.model ?? 'unknown-model'}`
}

const bucketKey = (b: Pick<Bucket, 'model' | 'band'>): string => `${b.model}|${b.band}`

/** 把一次用量加进对应的（模型, 时段）桶；桶按键排序，同一份日志得到同一个数组。 */
function addToBucket(buckets: readonly Bucket[], add: Bucket): readonly Bucket[] {
  const key = bucketKey(add)
  if (!buckets.some(b => bucketKey(b) === key)) {
    return [...buckets, add].sort((a, b) => (bucketKey(a) < bucketKey(b) ? -1 : bucketKey(a) > bucketKey(b) ? 1 : 0))
  }
  return buckets.map(b => bucketKey(b) === key
    ? {
        model: b.model,
        band: b.band,
        uncached: b.uncached + add.uncached,
        cacheRead: b.cacheRead + add.cacheRead,
        cacheWrite: b.cacheWrite + add.cacheWrite,
        output: b.output + add.output,
      }
    : b)
}

/** 由状态与当前币种算出客户端视图。币种未知时费用为 0，但 token 与不计价模型照常显示。 */
function viewOf(state: GoalBudgetState, currency: Currency | undefined): GoalBudgetView {
  let costUsd = 0
  const perModel = new Map<string, { tokens: number; costUsd: number; priced: boolean }>()
  for (const b of state.buckets) {
    const cost = currency === undefined
      ? 0
      : costOfTariff(
          { inputTokens: b.uncached, cacheReadTokens: b.cacheRead, cacheWriteTokens: b.cacheWrite, outputTokens: b.output },
          ratesFor(b.model, currency, b.band),
        )
    costUsd += cost
    const line = perModel.get(b.model) ?? { tokens: 0, costUsd: 0, priced: true }
    perModel.set(b.model, { tokens: line.tokens + b.uncached + b.cacheRead + b.cacheWrite + b.output, costUsd: line.costUsd + cost, priced: true })
  }
  for (const u of state.unpriced) perModel.set(u.key, { tokens: u.tokens, costUsd: 0, priced: false })
  return {
    budget: state.budget,
    spent: {
      tokens: state.tokens,
      costUsd,
      currency: currency ?? null,
      unbilledTurns: state.unbilledTurns,
      unpricedModels: state.unpriced.map(u => u.key),
      models: [...perModel.entries()]
        .map(([model, line]) => ({ model, ...line }))
        .sort((a, b) => b.costUsd - a.costUsd || (a.model < b.model ? -1 : 1)),
    },
  }
}

/**
 * 构造投影定义。
 *
 * @param options - 计价口径；必须与宿主同源，否则两边会分歧。
 */
export function createGoalBudgetProjection(options: {
  /** 当前账户币种；尚未识别时返回 undefined。读取视图时调用。 */
  readonly currency?: () => Currency | undefined
  /** 模型别名表。 */
  readonly aliases?: ModelAliases
  /** 是否按官方峰谷时段计价；网关线路为 false（见 bandFor 的实测依据）。 */
  readonly peakPricing?: boolean
} = {}) {
  const getCurrency = options.currency ?? (() => undefined)
  const aliases = options.aliases ?? {}
  const peakPricing = options.peakPricing ?? true
  return {
    key: 'goalBudget',
    stateSchema,

    init(): GoalBudgetState {
      return EMPTY
    },

    /**
     * 只关心四类事件；其余**必须返回同一个引用**（框架要求，否则触发下游重算）。
     */
    apply(state: GoalBudgetState, event: { type?: string; time?: number; data?: unknown }): GoalBudgetState {
      const data = event?.data as Record<string, unknown> | undefined

      // ── ① 路由：记下本会话当前用的模型 ──
      if (event?.type === 'request/header') {
        const cfg = (data?.['header'] as { config?: { provider?: unknown; model?: unknown } } | undefined)?.config
        const provider = typeof cfg?.provider === 'string' ? cfg.provider : undefined
        const model = typeof cfg?.model === 'string' ? cfg.model : undefined
        if (state.route?.provider === provider && state.route?.model === model) return state
        return { ...state, route: { provider, model } }
      }

      // ── ② /budget 命令 ──
      if (event?.type === 'command/run') {
        if (data?.['name'] !== 'budget') return state
        const parsed = parseBudgetCommand(typeof data['args'] === 'string' ? data['args'] : '')
        switch (parsed.kind) {
          case 'set':
            return {
              ...state,
              budget: { tokens: parsed.budget.tokens, costUsd: parsed.budget.costUsd, costCurrency: parsed.budget.costCurrency ?? null },
            }
          case 'clear':
            return state.budget === null ? state : { ...state, budget: null }
          default:
            return state
        }
      }

      // ── ③ 模型消费：记入（模型, 峰谷时段）桶 ──
      if (event?.type === 'assistant/message') {
        const usage = data?.['usage'] as TokenUsage | undefined
        if (usage === undefined) {
          // 适配器没报 usage —— 明确记为不可归因，不猜（失败模式 #4）
          return { ...state, unbilledTurns: state.unbilledTurns + 1 }
        }
        const tokens = state.tokens + billedTokensOf(usage)
        const model = canonicalDeepSeekModel(state.route?.model, aliases)
        if (model === undefined) {
          // 不是可计价的模型：token 计入，费用不计，并列出模型名。不用别的模型的价格去猜。
          return { ...state, tokens, unpriced: addUnpriced(state.unpriced, routeKey(state.route), billedTokensOf(usage)) }
        }
        return {
          ...state,
          tokens,
          buckets: addToBucket(state.buckets, {
            model,
            band: bandFor(event.time ?? 0, peakPricing),
            uncached: usage.inputTokens,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
            output: usage.outputTokens,
          }),
        }
      }

      return state
    },

    /** 客户端视图：金额按当前币种计算，路由与桶不送出。 */
    wire: {
      viewSchema,
      view: (state: GoalBudgetState): GoalBudgetView => viewOf(state, getCurrency()),
    },

    /** 官方日历的内容参与版本号：日历变了，持久化的旧状态（峰谷已按旧日历分桶）必须重建。 */
    // 7_000_000：状态形状变了（unpriced 带 token 数、视图加分模型明细），旧缓存必须重建。
    stateVersion: 7_000_000 + digestOf(OFF_DAYS.join(',')),
  } as const
}

// ★ 声明 key，客户端才能 useProjection('goalBudget')。
//   模板来自 packages/goal/goal/src/types.ts:128-137。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 本会话的资源上限与实际花费；花费按账户币种与峰谷时段计价。 */
    goalBudget: GoalBudgetView
  }
}
