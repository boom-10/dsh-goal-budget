/**
 * 会话级预算的**投影** —— 从 `command/run` 事件里 fold 出 `/budget` 的设置。
 *
 * ## 为什么用投影，而不是内存 Map
 *
 * 第一版把 `/budget` 的覆盖存在 `WeakMap` 里，有两个问题：
 *   1. **重启丢失**（失败模式 #9）—— 会话恢复后预算没了
 *   2. **客户端读不到** —— 浏览器半边要显示「花了多少 / 上限多少」，拿不到这个值
 *
 * 而 `/budget` 的输入**本来就已经写进会话日志了**（`command/run` 的 `args`，
 * 见 packages/interaction/commands/src/index.ts:373）。既然事实已经在日志里，
 * 就该从日志重建 —— 这样重启、fork、excerpt 全都自动正确。
 *
 * 投影是这个框架里干这件事的标准位置，`wire` 字段就是给客户端读的视图。
 */

import { z } from 'zod'
import { parseBudgetCommand } from './budget-command.ts'

/** 客户端能读到的形状。`null` 表示本会话没有设过覆盖。 */
export interface GoalBudgetView {
  readonly tokens: number
  readonly costUsd: number
}

// wire 视图的校验。注意必须 `.nullable()`：没设过 /budget 时 fold 出的状态是 null，
// view 会原样返回它，DSH 读历史时会对它 parse。非空 schema 会让每个没设预算的会话
// 历史加载失败（0.4.0 的事故）。
const viewObjectSchema = z.object({
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
}).strict()
const viewSchema = z.nullable(viewObjectSchema)

/** fold 的状态就是客户端能读的值，没有额外内部状态。 */
type State = GoalBudgetView | null

/** 该会话是否设过 `/budget`；设了就是覆盖值，没设就是 `null`。 */
export const goalBudgetProjectionDefinition = {
  key: 'goalBudget',
  // 框架只要求「有个能校验持久化状态的 schema」。
  // union 的推断类型这里不重要，因为 apply() 的签名已经钉死了 State。
  stateSchema: viewSchema,

  init(): State {
    return null
  },

  /**
   * 只关心 `command/run` 里命令名为 `budget` 的事件。
   *
   * ⚠️ 框架要求：不关心的事件**必须返回同一个引用**，
   * 否则每次事件都会触发下游重算。
   */
  apply(state: State, event: { type?: string; data?: unknown }): State {
    if (event?.type !== 'command/run') return state
    const data = event.data as { name?: string; args?: string } | undefined
    if (data?.name !== 'budget') return state

    const parsed = parseBudgetCommand(data.args ?? '')
    switch (parsed.kind) {
      case 'set':
        return { tokens: parsed.budget.tokens, costUsd: parsed.budget.costUsd }
      case 'clear':
        return state === null ? state : null
      // show / invalid 不改变状态
      default:
        return state
    }
  },

  /** 客户端视图：把 fold 状态原样送出去（它本来就是纯 JSON）。 */
  wire: {
    viewSchema,
    view: (state: State): GoalBudgetView | null => state,
  },

  stateVersion: 1,
} as const

// ★ 声明 key，客户端才能通过 useProjection('goalBudget') 读到。
//   模板来自 packages/goal/goal/src/types.ts:128-137。
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * 本会话通过 `/budget` 设置的资源上限；`null` 表示没设过，
     * 此时以 profile 的 `Config` 默认值为准。
     */
    goalBudget: GoalBudgetView | null
  }
}
