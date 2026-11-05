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

/**
 * 一次 turn 的消费。
 *
 * `attributable: false` 表示适配器没报 usage（失败模式 #4）。
 *
 * `startedAt` / `endedAt` 取自会话事件自带的 `SessionEvent.time`
 * （packages/core/session/src/types.ts:507，Unix epoch 毫秒）。
 * **只用事件时间，不用 `Date.now()`** —— 否则重放同一份日志会得到不同的数，
 * 归因就不再是「从日志重建」而是「记住」了。
 */
export type TurnSpend = {
  turn: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  attributable: boolean
  /** 该轮第一个事件的时间。`undefined` = 还没见过这一轮的任何事件。 */
  startedAt?: number
  /** 该轮最新事件的时间。 */
  endedAt?: number
}

export type GoalSpend = {
  goalId: string
  /** round → 该轮的消费 */
  rounds: Map<number, TurnSpend>
  /** 无法归因的 turn 数（适配器没报 usage） */
  unattributableTurns: number
  /** 没有单价的 turn 数：token 计入，费用不计。 */
  unpricedTurns?: number
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
  // 三个输入桶并列（packages/llm/llm/src/types.ts:177）：inputTokens 只含未命中缓存的部分，
  // 缓存命中在 cacheReadTokens。不能从 inputTokens 里再扣一次 —— 0.5.0 就是这么错的。
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  // DeepSeek 不对缓存写入单独收费，按未命中价计（实测会话的 cacheWrite 为 0）。
  // reasoningTokens 是 outputTokens 的子集（token-meter 的 turn-usage.spec.ts 把
  // 「reasoning 超过 output」列为非法），所以只按输出价计一次。
  return (
    ((usage.inputTokens + cacheWrite) / M) * p.inputPerMillion +
    (cacheRead / M) * p.cacheReadPerMillion +
    (usage.outputTokens / M) * p.outputPerMillion
  )
}

/**
 * 计费口径的 token 数：三个输入桶加输出。
 *
 * 与宿主 UsagePill 的「用量」一致（token-meter 的 billedInputTokens + outputTokens）。
 * 预算的 token 上限用这个数，所以缓存命中也计入 —— 否则在 98% 缓存命中的会话里，
 * token 上限只会数到 2% 的实际用量。
 */
export function billedTokensOf(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
}

/**
 * 一个模型的价格（每百万 token）。按模型 id 匹配，不区分网关。
 *
 * 价格表来自插件配置。DSH 的公开接口不暴露单价（LlmModelInfo 里没有 cost；
 * pi-ai 目录里查不到的模型，单价会默认成 0），所以插件不能向 DSH 要价格。
 */
export type PriceEntry = {
  readonly model: string
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion: number
  /** 高峰价相对非高峰价的倍数；1 表示不分时段。官方 DeepSeek 为 2。 */
  readonly peakMultiplier: number
  /** `YYYY-MM-DD` 列表：这些日期全天按非高峰计。官方排除中国法定节假日，这里由你维护。 */
  readonly holidays: readonly string[]
}

/** 官方 DeepSeek 非高峰价，来源 api-docs.deepseek.com/quick_start/pricing。 */
export const DEFAULT_PRICES: readonly PriceEntry[] = [
  { model: 'deepseek-flash', inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003, peakMultiplier: 2, holidays: [] },
  { model: 'deepseek-v4-pro', inputPerMillion: 0.66, outputPerMillion: 1.98, cacheReadPerMillion: 0.022, peakMultiplier: 2, holidays: [] },
]

/** 不计费：用于没有单价的模型（token 仍然计入）。 */
export const UNPRICED: Pricing = { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 }

/** 按模型 id 找价格。找不到返回 undefined；调用方必须显式处理，不能用别的模型的价格顶替。 */
export function findPriceByModel(entries: readonly PriceEntry[], model: string | undefined): PriceEntry | undefined {
  if (model === undefined) return undefined
  return entries.find(e => e.model === model)
}

/**
 * 某一时刻是否为高峰时段。
 *
 * 官方规则：UTC 01:00–04:00 与 06:00–10:00，周一至周五，中国法定节假日除外（节假日全天非高峰）。
 * 节假日用 UTC 日期判断：这两个窗口换算成北京时间仍是同一天，所以两种日期一致。
 */
export function isPeak(at: number, holidays: readonly string[]): boolean {
  const d = new Date(at)
  const hour = d.getUTCHours()
  if (!((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return false
  const weekday = d.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  return !holidays.includes(d.toISOString().slice(0, 10))
}

/** 一条价格在某一时刻的实际单价。`at` 缺失时按非高峰计（事件总带 time，这只是类型上的保险）。 */
export function pricingAt(e: PriceEntry, at: number | undefined): Pricing {
  if (at === undefined || !isPeak(at, e.holidays)) {
    return { inputPerMillion: e.inputPerMillion, outputPerMillion: e.outputPerMillion, cacheReadPerMillion: e.cacheReadPerMillion }
  }
  const m = e.peakMultiplier
  return {
    inputPerMillion: e.inputPerMillion * m,
    outputPerMillion: e.outputPerMillion * m,
    cacheReadPerMillion: e.cacheReadPerMillion * m,
  }
}

/** 价格表的稳定摘要（FNV-1a），用于投影缓存版本：价格变了，旧缓存必须重建。 */
export function priceDigest(entries: readonly PriceEntry[]): number {
  const text = JSON.stringify(entries)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 1_000_000
}

/**
 * 记录「这一轮还没开始」—— 第一个事件的时间就是这一轮的起点。
 *
 * 幂等：已经有 `startedAt` 就不动它，否则每一轮都会被后来事件的时间覆盖。
 */
export function openRound(prev: TurnSpend, at: number): TurnSpend {
  if (prev.startedAt !== undefined) {
    return prev.endedAt !== undefined && prev.endedAt >= at ? prev : { ...prev, endedAt: at }
  }
  return { ...prev, startedAt: at, endedAt: at }
}

/**
 * 累加一次 turn 的 usage 到一个桶里。
 *
 * @param at - 该事件的 `SessionEvent.time`；给了就推进这一轮的 `endedAt`。
 */
export function addUsage(prev: TurnSpend, usage: TokenUsage | undefined, p: Pricing, at?: number): TurnSpend {
  const end = at === undefined ? prev.endedAt : Math.max(prev.endedAt ?? at, at)
  if (usage === undefined) {
    // 适配器没报 usage —— 明确记为不可归因，不猜（失败模式 #4）
    return { ...prev, attributable: false, endedAt: end }
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
    // 时间字段必须显式带过去：上面是逐字段构造，漏掉 startedAt 会让整轮的
    // 时长被 totalsOf 当作「未开始」而丢掉（这正是 wallclock.spec 抓到的 bug）。
    startedAt: prev.startedAt,
    endedAt: end,
  }
}

/**
 * 一个 goal 的累计值。
 *
 * ## 为什么 `wallClockMs` 是「各轮跨度之和」而不是 `now - createdAt`
 *
 * 用 `now - createdAt` 会算进**暂停时间**：一个目标暂停一整夜，第二天恢复时
 * 30 分钟的预算立刻爆掉 —— 而它其实只跑了几分钟。
 *
 * 累加每一轮自己的跨度（`endedAt - startedAt`），得到的是**真正在跑的时间**，
 * 这才是一个人设时间预算时想要的东西。
 *
 * ⚠️ 代价：轮与轮之间的空闲不计入。一个目标可以「跑了 3 天但只用了 20 分钟
 *    计算时间」—— 对这个插件的目的（约束计算）来说这是**对的**，但必须说清楚。
 */
export function totalsOf(spend: GoalSpend): {
  tokens: number
  costUsd: number
  rounds: number
  wallClockMs: number
} {
  let tokens = 0
  let costUsd = 0
  let wallClockMs = 0
  for (const t of spend.rounds.values()) {
    tokens += t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens
    costUsd += t.costUsd
    if (t.startedAt !== undefined && t.endedAt !== undefined) {
      wallClockMs += Math.max(0, t.endedAt - t.startedAt)
    }
  }
  return { tokens, costUsd, rounds: spend.rounds.size, wallClockMs }
}

/** 预算的三个维度。 */
export type BudgetKind = 'tokens' | 'costUsd' | 'wallClockMs'

/** 判断是否超预算；返回触发的维度与比例（用于告警阈值）。 */
export function checkBudget(
  spend: GoalSpend,
  budget: { tokens?: number; costUsd?: number; wallClockMs?: number },
):
  | { exceeded: false; ratio: number }
  | { exceeded: true; ratio: number; kind: BudgetKind; limit: number; used: number } {
  const t = totalsOf(spend)
  const ratios: Array<{ kind: BudgetKind; ratio: number; limit: number; used: number }> = []
  if (budget.tokens && budget.tokens > 0) {
    ratios.push({ kind: 'tokens', ratio: t.tokens / budget.tokens, limit: budget.tokens, used: t.tokens })
  }
  if (budget.costUsd && budget.costUsd > 0) {
    ratios.push({ kind: 'costUsd', ratio: t.costUsd / budget.costUsd, limit: budget.costUsd, used: t.costUsd })
  }
  if (budget.wallClockMs && budget.wallClockMs > 0) {
    ratios.push({
      kind: 'wallClockMs', ratio: t.wallClockMs / budget.wallClockMs,
      limit: budget.wallClockMs, used: t.wallClockMs,
    })
  }
  if (ratios.length === 0) return { exceeded: false, ratio: 0 }
  const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  return worst.ratio >= 1
    ? { exceeded: true, ratio: worst.ratio, kind: worst.kind, limit: worst.limit, used: worst.used }
    : { exceeded: false, ratio: worst.ratio }
}
