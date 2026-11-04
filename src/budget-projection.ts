/**
 * 会话的资源状态投影 —— 上限（`/budget`）与实际花费（`assistant/message` 的 usage）。
 *
 * ## 为什么花费也在投影里，而不是让客户端自己算
 *
 * 客户端的 `tokenUsage` 投影只给**合计**（uncachedInputTokens / outputTokens /
 * cacheReadTokens / cacheWriteTokens），而正确的计价是**逐条** `max(0, input − cacheRead)`
 * 再累加 —— 因为单条记录的 `inputTokens` 包含 `cacheReadTokens`，但某个会话的
 * cacheRead 合计可能远大于 input 合计（实测一条真实会话：input 4.87M vs cacheRead 400M）。
 * 合计相减会归零，与宿主的数差 15%+。
 *
 * 所以这里 fold 每条 usage、用**和宿主 accounting.ts 同一个 costOf** 累加，
 * 客户端只负责显示。**一个数字只有一个来源，就不会有分歧。**
 */

import { z } from 'zod'
import { costOf, type Pricing } from './accounting.ts'
import { parseBudgetCommand } from './budget-command.ts'

/** 客户端读到的形状。 */
export interface GoalBudgetState {
  /** 本会话通过 `/budget` 设的上限；`null` 表示没设过（此时可能仍有 profile 默认）。 */
  readonly budget: { readonly tokens: number; readonly costUsd: number } | null
  /** 本会话累计花费，用宿主的 costOf 算 —— 与阻断判定同一个口径。 */
  readonly spent: {
    readonly tokens: number
    readonly costUsd: number
    /** 适配器没报 usage 的 turn 数（这些消费无法归因）。 */
    readonly unbilledTurns: number
  }
}

// nonnegative：上限为负没有意义，而且会让 checkBudget 的比值变成负数（静默失效）。
const budgetSchema = z.object({ tokens: z.number().nonnegative(), costUsd: z.number().nonnegative() }).strict()
const spentSchema = z.object({
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  unbilledTurns: z.number().int().nonnegative(),
}).strict()

/** ★ 必须 nullable：没设过 `/budget` 时 budget 是 null，DSH 读历史会 parse 这个值。 */
const stateSchema = z.object({ budget: z.nullable(budgetSchema), spent: spentSchema }).strict()

/** 与该投影配套的单价 —— 与宿主 Config 的默认值一致。 */
export const DEFAULT_PRICING: Pricing = {
  inputPerMillion: 0.15,
  outputPerMillion: 0.6,
  cacheReadPerMillion: 0.003,
}

const EMPTY: GoalBudgetState = {
  budget: null,
  spent: { tokens: 0, costUsd: 0, unbilledTurns: 0 },
}

/**
 * 构造投影定义。
 *
 * @param pricing - 与宿主 Config 同源的单价；改变它必须同时 bump stateVersion。
 */
export function createGoalBudgetProjection(pricing: Pricing = DEFAULT_PRICING) {
  return {
    key: 'goalBudget',
    stateSchema,

    init(): GoalBudgetState {
      return EMPTY
    },

    /**
     * 只关心两类事件，其余**必须返回同一个引用**（框架要求，否则触发下游重算）。
     */
    apply(state: GoalBudgetState, event: { type?: string; data?: unknown }): GoalBudgetState {
      const data = event?.data as Record<string, unknown> | undefined

      // ── ① /budget 命令 ──
      if (event?.type === 'command/run') {
        if (data?.['name'] !== 'budget') return state
        const parsed = parseBudgetCommand(typeof data['args'] === 'string' ? data['args'] : '')
        switch (parsed.kind) {
          case 'set':
            return { budget: { tokens: parsed.budget.tokens, costUsd: parsed.budget.costUsd }, spent: state.spent }
          case 'clear':
            return state.budget === null ? state : { budget: null, spent: state.spent }
          default:
            return state
        }
      }

      // ── ② 模型消费 ──
      if (event?.type === 'assistant/message') {
        const usage = data?.['usage'] as
          | { inputTokens: number; outputTokens: number; cacheReadTokens?: number; reasoningTokens?: number }
          | undefined

        if (usage === undefined) {
          // 适配器没报 usage —— 明确记为不可归因，不猜（失败模式 #4）
          return {
            budget: state.budget,
            spent: { ...state.spent, unbilledTurns: state.spent.unbilledTurns + 1 },
          }
        }

        const freshInput = Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0))
        return {
          budget: state.budget,
          spent: {
            tokens: state.spent.tokens + freshInput + usage.outputTokens + (usage.reasoningTokens ?? 0),
            costUsd: state.spent.costUsd + costOf(usage, pricing),
            unbilledTurns: state.spent.unbilledTurns,
          },
        }
      }

      return state
    },

    /** 客户端视图：状态本身就是纯 JSON，原样送出。 */
    wire: {
      viewSchema: stateSchema,
      view: (state: GoalBudgetState): GoalBudgetState => state,
    },

    stateVersion: 2,
  } as const
}

// ★ 声明 key，客户端才能 useProjection('goalBudget')。
//   模板来自 packages/goal/goal/src/types.ts:128-137。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 本会话的资源上限与实际花费；花费与阻断判定同一个口径。 */
    goalBudget: GoalBudgetState
  }
}
