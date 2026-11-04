/**
 * 归因与计费 —— **纯函数，不碰 ctx**。
 *
 * 拆出来的理由：这部分是最容易出错、最需要单测的地方（归因错 = 提前阻断）。
 * 把它做成纯 reducer，就能不启动宿主、不调模型地测。
 */

/** 与 `@deepseek-ai/dsh-llm` 的 TokenUsage 同形（此处不 import，避免运行时依赖） */
export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type Pricing = {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
}

/** 一次 turn 的消费。`attributable: false` 表示适配器没报 usage（失败模式 #4）。 */
export type TurnSpend = {
  turn: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  attributable: boolean
}

export type GoalSpend = {
  goalId: string
  /** round → 该轮的消费 */
  rounds: Map<number, TurnSpend>
  /** 无法归因的 turn 数（适配器没报 usage） */
  unattributableTurns: number
}

/** 归因表：turn → 这个 turn 属于哪个 goal 的哪一轮 */
export type TurnOwnership = { goalId: string; round: number }

/**
 * 计费。
 *
 * ★ cacheRead 必须与 input 分开算 —— 两者单价差 50 倍（第 0004 节实测）。
 * 不区分的话成本会算错一个数量级。
 */
export function costOf(usage: TokenUsage, p: Pricing): number {
  const M = 1_000_000
  const cacheRead = usage.cacheReadTokens ?? 0
  // inputTokens 是否已包含 cacheRead，各适配器口径可能不同。
  // 保守做法：从 inputTokens 里扣掉 cacheRead，避免重复计费。
  const freshInput = Math.max(0, usage.inputTokens - cacheRead)
  return (
    (freshInput / M) * p.inputPerMillion +
    (cacheRead / M) * p.cacheReadPerMillion +
    ((usage.outputTokens + (usage.reasoningTokens ?? 0)) / M) * p.outputPerMillion
  )
}

/** 累加一次 turn 的 usage 到一个桶里。 */
export function addUsage(prev: TurnSpend, usage: TokenUsage | undefined, p: Pricing): TurnSpend {
  if (usage === undefined) {
    // 适配器没报 usage —— 明确记为不可归因，不猜（失败模式 #4）
    return { ...prev, attributable: false }
  }
  // 显式列出每个字段 —— 不用 spread。
  // 理由：TokenUsage 的字段是可选的，TurnSpend 的是必需的，
  // spread 会把「可选」原样带过去，类型对不上（而且真的会漏字段）。
  return {
    turn: prev.turn,
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: prev.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: prev.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: prev.costUsd + costOf(usage, p),
    attributable: true,
  }
}

/** 一个 goal 的累计值。 */
export function totalsOf(spend: GoalSpend): { tokens: number; costUsd: number; rounds: number } {
  let tokens = 0
  let costUsd = 0
  for (const t of spend.rounds.values()) {
    tokens += t.inputTokens + t.outputTokens + t.reasoningTokens
    costUsd += t.costUsd
  }
  return { tokens, costUsd, rounds: spend.rounds.size }
}

/** 判断是否超预算；返回触发的维度与比例（用于告警阈值）。 */
export function checkBudget(
  spend: GoalSpend,
  budget: { tokens?: number; costUsd?: number },
): { exceeded: false; ratio: number } | { exceeded: true; ratio: number; kind: 'tokens' | 'costUsd'; limit: number; used: number } {
  const t = totalsOf(spend)
  const ratios: Array<{ kind: 'tokens' | 'costUsd'; ratio: number; limit: number; used: number }> = []
  if (budget.tokens && budget.tokens > 0) {
    ratios.push({ kind: 'tokens', ratio: t.tokens / budget.tokens, limit: budget.tokens, used: t.tokens })
  }
  if (budget.costUsd && budget.costUsd > 0) {
    ratios.push({ kind: 'costUsd', ratio: t.costUsd / budget.costUsd, limit: budget.costUsd, used: t.costUsd })
  }
  if (ratios.length === 0) return { exceeded: false, ratio: 0 }
  const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  return worst.ratio >= 1
    ? { exceeded: true, ratio: worst.ratio, kind: worst.kind, limit: worst.limit, used: worst.used }
    : { exceeded: false, ratio: worst.ratio }
}
