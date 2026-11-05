/**
 * 会话的资源状态投影 —— 上限（`/budget`）与实际花费（`assistant/message` 的 usage）。
 *
 * ## 按会话当前的模型计价
 *
 * `request/header` 记录本会话的路由（provider、model）。之后的 `assistant/message`
 * 归因到这个模型，再按价格表查它的单价。换模型、换网关，计价都跟着走，
 * 不会沿用另一个模型的价格。
 *
 * 查不到单价的模型不猜：token 照常计入，费用不计，并把模型名列进 `unpricedModels`。
 */

import { z } from 'zod'
import {
  billedTokensOf, costOf, DEFAULT_PRICES, findPriceByModel, priceDigest, pricingAt,
  type PriceEntry, type TokenUsage,
} from './accounting.ts'
import { parseBudgetCommand } from './budget-command.ts'

/** 客户端读到的形状。 */
export interface GoalBudgetView {
  /** 本会话通过 `/budget` 设的上限；`null` 表示没设过（此时可能仍有 profile 默认）。 */
  readonly budget: { readonly tokens: number; readonly costUsd: number } | null
  /** 本会话累计用量与花费。 */
  readonly spent: {
    readonly tokens: number
    readonly costUsd: number
    /** 适配器没报 usage 的 turn 数（这些消费无法归因）。 */
    readonly unbilledTurns: number
    /** 用过但没有单价的模型（`provider/model`）；它们的费用没有计入 costUsd。 */
    readonly unpricedModels: readonly string[]
  }
}

/** 投影状态：视图加上当前路由。路由是内部状态，不送给客户端。 */
export interface GoalBudgetState extends GoalBudgetView {
  readonly route: { readonly provider: string | undefined; readonly model: string | undefined } | null
}

const budgetSchema = z.object({ tokens: z.number().nonnegative(), costUsd: z.number().nonnegative() }).strict()
const spentSchema = z.object({
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  unbilledTurns: z.number().int().nonnegative(),
  unpricedModels: z.array(z.string()),
}).strict()
const viewSchema = z.object({ budget: z.nullable(budgetSchema), spent: spentSchema }).strict()
const routeSchema = z.object({ provider: z.string().optional(), model: z.string().optional() }).strict()
const stateSchema = z.object({
  budget: z.nullable(budgetSchema),
  spent: spentSchema,
  route: z.nullable(routeSchema),
}).strict()

const EMPTY: GoalBudgetState = {
  budget: null,
  spent: { tokens: 0, costUsd: 0, unbilledTurns: 0, unpricedModels: [] },
  route: null,
}

/** 加入一个未定价的模型名；保持排序去重，同一份日志得到同一个数组。 */
function addUnpriced(list: readonly string[], key: string): readonly string[] {
  return list.includes(key) ? list : [...list, key].sort()
}

/** 路由的显示名；缺失的字段显式标出，而不是留空。 */
function routeKey(route: GoalBudgetState['route']): string {
  return `${route?.provider ?? 'unknown-provider'}/${route?.model ?? 'unknown-model'}`
}

/**
 * 构造投影定义。
 *
 * @param prices - 价格表；改变它会改变 stateVersion，旧缓存随之重建。
 */
export function createGoalBudgetProjection(prices: readonly PriceEntry[] = DEFAULT_PRICES) {
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
            return { ...state, budget: { tokens: parsed.budget.tokens, costUsd: parsed.budget.costUsd } }
          case 'clear':
            return state.budget === null ? state : { ...state, budget: null }
          default:
            return state
        }
      }

      // ── ③ 模型消费：按当前路由的模型计价 ──
      if (event?.type === 'assistant/message') {
        const usage = data?.['usage'] as TokenUsage | undefined
        const spent = state.spent
        if (usage === undefined) {
          // 适配器没报 usage —— 明确记为不可归因，不猜（失败模式 #4）
          return { ...state, spent: { ...spent, unbilledTurns: spent.unbilledTurns + 1 } }
        }
        const tokens = spent.tokens + billedTokensOf(usage)
        const entry = findPriceByModel(prices, state.route?.model)
        if (entry === undefined) {
          // 没有单价：token 计入，费用不计，并列出模型名。不用别的模型的价格去猜。
          return {
            ...state,
            spent: { ...spent, tokens, unpricedModels: addUnpriced(spent.unpricedModels, routeKey(state.route)) },
          }
        }
        return {
          ...state,
          spent: { ...spent, tokens, costUsd: spent.costUsd + costOf(usage, pricingAt(entry, event.time)) },
        }
      }

      return state
    },

    /** 客户端视图：去掉内部路由，其余原样送出。 */
    wire: {
      viewSchema,
      view: (state: GoalBudgetState): GoalBudgetView => ({ budget: state.budget, spent: state.spent }),
    },

    /** 价格表的摘要参与版本号：价格变了，持久化的旧缓存会被丢弃并重算。 */
    stateVersion: 5_000_000 + priceDigest(prices),
  } as const
}

// ★ 声明 key，客户端才能 useProjection('goalBudget')。
//   模板来自 packages/goal/goal/src/types.ts:128-137。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 本会话的资源上限与实际花费；花费按会话当前模型计价。 */
    goalBudget: GoalBudgetView
  }
}
