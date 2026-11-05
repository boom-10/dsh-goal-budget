/**
 * `/budget` 命令的解析与渲染 —— **纯函数，不碰 ctx**。
 *
 * 为什么要单独一个文件：语法解析是最容易出错、最需要单测的部分，
 * 而且它和宿主无关。做成纯函数就能不启动宿主、不调模型地测。
 */

/**
 * 一个预算额度。三个维度都为 0 表示「无限制」。
 *
 * 三个维度是**并列**的，谁先到算谁（见 `checkBudget`）。
 */
/** 费用金额的币种。 */
export type CostCurrency = 'USD' | 'CNY'

export interface Budget {
  readonly tokens: number
  /** 费用上限，单位见 costCurrency（缺省美元）。字段名沿用旧版本，避免破坏已发布的快照格式。 */
  readonly costUsd: number
  /** 计算时间上限（毫秒）。0 = 不限制。 */
  readonly wallClockMs: number
  /** 费用上限的币种。只有 costUsd > 0 时才有意义。 */
  readonly costCurrency?: CostCurrency
}

/** `/budget` 的解析结果。 */
export type BudgetCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly budget: Budget; readonly label: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** 无限制预算。 */
export const UNLIMITED: Budget = { tokens: 0, costUsd: 0, wallClockMs: 0 }

/** 是否等于无限制。 */
export function isUnlimited(b: Budget): boolean {
  return b.tokens <= 0 && b.costUsd <= 0 && b.wallClockMs <= 0
}

const MINUTE = 60_000
const HOUR = 3_600_000

/**
 * 时长单位 → 毫秒。
 *
 * ★ 这里**刻意不收 `m`**：`m` 已经被 token 的「百万」占用
 *   （`1.5m` = 150 万 token）。让同一个字母有两种含义，用户一定会写错，
 *   而且错了不会报错 —— 只会安静地设成一个荒谬的上限。
 *   所以分钟必须写 `min`。
 */
const DURATION_UNITS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
}

/** 人类可读的时长：`1800000` → `30min`。 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0'
  if (ms % HOUR === 0) return `${ms / HOUR}h`
  if (ms % MINUTE === 0) return `${ms / MINUTE}min`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${(ms / MINUTE).toFixed(1)}min`
}

/**
 * 解析一个数量词。
 *
 * 支持：
 * - 金额：`$5` · `$0.50` · `5$`
 * - token：`500000` · `500k` · `1.5m`
 * - 时长：`30s` · `5min` · `2h`（**`m` 不表示分钟**，见 DURATION_UNITS 的说明）
 *
 * @param raw - 用户输入的单个词。
 * @returns 解析结果；无法解析时 `undefined`。
 */
function parseAmount(
  raw: string,
): { kind: 'tokens' | 'costUsd' | 'wallClockMs'; value: number; currency?: CostCurrency } | undefined {
  const text = raw.trim().toLowerCase()
  if (text.length === 0) return undefined

  // 金额（美元）：$5 / $0.50 / 5$
  const usd = /^\$(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\$$/.exec(text)
  if (usd) {
    const value = Number(usd[1] ?? usd[2])
    return Number.isFinite(value) && value > 0 ? { kind: 'costUsd', value, currency: 'USD' } : undefined
  }

  // 金额（人民币）：¥30 / 30¥ / 30元 / cny30 / 30cny
  const cny = /^(?:¥|cny)(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)(?:¥|元|cny)$/.exec(text)
  if (cny) {
    const value = Number(cny[1] ?? cny[2])
    return Number.isFinite(value) && value > 0 ? { kind: 'costUsd', value, currency: 'CNY' } : undefined
  }

  // 时长：30s / 5min / 2h —— 先试，因为 's'/'h' 不会被 token 规则吃掉
  const dur = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(text)
  if (dur) {
    const unit = DURATION_UNITS[dur[2]!]
    if (unit !== undefined) {
      const base = Number(dur[1])
      if (!Number.isFinite(base) || base <= 0) return undefined
      return { kind: 'wallClockMs', value: Math.round(base * unit) }
    }
  }

  // token：500000 / 500k / 1.5m
  const tok = /^(\d+(?:\.\d+)?)([km])?$/.exec(text)
  if (tok) {
    const base = Number(tok[1])
    if (!Number.isFinite(base) || base <= 0) return undefined
    const mult = tok[2] === 'k' ? 1_000 : tok[2] === 'm' ? 1_000_000 : 1
    return { kind: 'tokens', value: Math.round(base * mult) }
  }

  return undefined
}

/**
 * 解析 `/budget` 后面的输入。
 *
 * 语法：
 * - 空 → 显示当前
 * - `off` / `reset` / `none` → 清除会话覆盖，回到 profile 默认
 * - 一个金额词 → 设为该上限（另一个维度保持无限制）
 * - 两个词 → 同时设 token 和金额上限
 *
 * @param rawInput - `CommandInvocation.rawInput`（含前导空白）。
 */
export function parseBudgetCommand(rawInput: string): BudgetCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }

  const lower = input.toLowerCase()
  if (lower === 'off' || lower === 'reset' || lower === 'none' || lower === 'clear') {
    return { kind: 'clear' }
  }

  const words = input.split(/\s+/).filter(w => w.length > 0)
  let tokens = 0
  let costUsd = 0
  let costCurrency: CostCurrency | undefined
  let wallClockMs = 0
  const labels: string[] = []

  for (const word of words) {
    const parsed = parseAmount(word)
    if (parsed === undefined) {
      return {
        kind: 'invalid',
        reason: `无法理解的额度 "${word}"。用法：/budget $5 · /budget 500k · /budget 30min · /budget off`,
      }
    }
    switch (parsed.kind) {
      case 'costUsd':
        if (costUsd > 0) return { kind: 'invalid', reason: '金额只能写一次。' }
        costUsd = parsed.value
        costCurrency = parsed.currency ?? 'USD'
        labels.push(`${costCurrency === 'CNY' ? '¥' : '$'}${parsed.value}`)
        break
      case 'tokens':
        if (tokens > 0) return { kind: 'invalid', reason: 'token 数只能写一次。' }
        tokens = parsed.value
        labels.push(`${formatTokens(parsed.value)} tokens`)
        break
      case 'wallClockMs':
        if (wallClockMs > 0) return { kind: 'invalid', reason: '时长只能写一次。' }
        wallClockMs = parsed.value
        labels.push(formatDuration(parsed.value))
        break
    }
  }

  if (tokens === 0 && costUsd === 0 && wallClockMs === 0) {
    return { kind: 'invalid', reason: '至少要给一个上限。' }
  }
  return {
    kind: 'set',
    budget: { tokens, costUsd, wallClockMs, ...(costCurrency === undefined ? {} : { costCurrency }) },
    label: labels.join(' + '),
  }
}

/** 人类可读的 token 数：`523000` → `523k`。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

/** 人类可读的金额，带币种符号。 */
export function formatMoney(n: number, currency: CostCurrency = 'USD'): string {
  const symbol = currency === 'CNY' ? '¥' : '$'
  if (n === 0) return `${symbol}0`
  return n < 0.01 ? `${symbol}${n.toFixed(4)}` : `${symbol}${n.toFixed(n < 1 ? 3 : 2)}`
}

/** 人类可读的美元金额（旧调用方使用）。 */
export function formatUsd(n: number): string {
  return formatMoney(n, 'USD')
}

/** 预算的人类可读描述。 */
export function describeBudget(b: Budget): string {
  if (isUnlimited(b)) return '无限制'
  const parts: string[] = []
  if (b.tokens > 0) parts.push(`${formatTokens(b.tokens)} tokens`)
  if (b.costUsd > 0) parts.push(formatMoney(b.costUsd, b.costCurrency ?? 'USD'))
  if (b.wallClockMs > 0) parts.push(formatDuration(b.wallClockMs))
  return parts.join(' 或 ')
}

/**
 * 渲染 `/budget` 的显示输出。
 *
 * @param effective - 当前生效的预算（会话覆盖 ?? profile 默认）。
 * @param source - 这个预算从哪来，决定提示语。
 * @param used - 已消费；`undefined` 表示还没开始记账。
 */
export function renderBudget(
  effective: Budget,
  source: 'session' | 'profile',
  used: { tokens: number; costUsd: number; wallClockMs: number } | undefined,
): string {
  const lines: string[] = []
  const cur: CostCurrency = effective.costCurrency ?? 'USD'
  lines.push(`预算：${describeBudget(effective)}`)
  lines.push(source === 'session' ? '来源：本会话设置' : '来源：profile 默认')

  if (used !== undefined && !isUnlimited(effective)) {
    const ratios: string[] = []
    if (effective.tokens > 0) {
      const pct = ((used.tokens / effective.tokens) * 100).toFixed(0)
      ratios.push(`token ${formatTokens(used.tokens)} / ${formatTokens(effective.tokens)}（${pct}%）`)
    }
    if (effective.costUsd > 0) {
      const pct = ((used.costUsd / effective.costUsd) * 100).toFixed(0)
      ratios.push(`费用 ${formatMoney(used.costUsd, cur)} / ${formatMoney(effective.costUsd, cur)}（${pct}%）`)
    }
    if (effective.wallClockMs > 0) {
      const pct = ((used.wallClockMs / effective.wallClockMs) * 100).toFixed(0)
      ratios.push(`时间 ${formatDuration(used.wallClockMs)} / ${formatDuration(effective.wallClockMs)}（${pct}%）`)
    }
    if (ratios.length > 0) lines.push(`已用：${ratios.join(' · ')}`)
  } else if (used !== undefined) {
    lines.push(
      `已用：${formatTokens(used.tokens)} tokens · ${formatMoney(used.costUsd, cur)}` +
      ` · ${formatDuration(used.wallClockMs)}`,
    )
  }

  lines.push('用法：/budget $5 · /budget 500k · /budget 30min · /budget off')
  return lines.join('\n')
}
