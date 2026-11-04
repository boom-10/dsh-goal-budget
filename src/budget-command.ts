/**
 * `/budget` 命令的解析与渲染 —— **纯函数，不碰 ctx**。
 *
 * 为什么要单独一个文件：语法解析是最容易出错、最需要单测的部分，
 * 而且它和宿主无关。做成纯函数就能不启动宿主、不调模型地测。
 */

/** 一个预算额度。两个字段都为 0 表示「无限制」。 */
export interface Budget {
  readonly tokens: number
  readonly costUsd: number
}

/** `/budget` 的解析结果。 */
export type BudgetCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'set'; readonly budget: Budget; readonly label: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** 无限制预算。 */
export const UNLIMITED: Budget = { tokens: 0, costUsd: 0 }

/** 是否等于无限制。 */
export function isUnlimited(b: Budget): boolean {
  return b.tokens <= 0 && b.costUsd <= 0
}

/**
 * 解析一个数量词。
 *
 * 支持：`500000` · `500k` · `1.5m` · `$5` · `$0.50`
 *
 * @param raw - 用户输入的单个词。
 * @returns 解析结果；无法解析时 `undefined`。
 */
function parseAmount(raw: string): { kind: 'tokens' | 'costUsd'; value: number } | undefined {
  const text = raw.trim().toLowerCase()
  if (text.length === 0) return undefined

  // 金额：$5 / $0.50 / 5$
  const usd = /^\$(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\$$/.exec(text)
  if (usd) {
    const value = Number(usd[1] ?? usd[2])
    return Number.isFinite(value) && value > 0 ? { kind: 'costUsd', value } : undefined
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
  const labels: string[] = []

  for (const word of words) {
    const parsed = parseAmount(word)
    if (parsed === undefined) {
      return {
        kind: 'invalid',
        reason: `无法理解的额度 "${word}"。用法：/budget $5 · /budget 500k · /budget $5 500k · /budget off`,
      }
    }
    if (parsed.kind === 'costUsd') {
      if (costUsd > 0) return { kind: 'invalid', reason: '金额只能写一次。' }
      costUsd = parsed.value
      labels.push(`$${parsed.value}`)
    } else {
      if (tokens > 0) return { kind: 'invalid', reason: 'token 数只能写一次。' }
      tokens = parsed.value
      labels.push(`${formatTokens(parsed.value)} tokens`)
    }
  }

  if (tokens === 0 && costUsd === 0) {
    return { kind: 'invalid', reason: '至少要给一个上限。' }
  }
  return { kind: 'set', budget: { tokens, costUsd }, label: labels.join(' + ') }
}

/** 人类可读的 token 数：`523000` → `523k`。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

/** 人类可读的金额。 */
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(n < 1 ? 3 : 2)}`
}

/** 预算的人类可读描述。 */
export function describeBudget(b: Budget): string {
  if (isUnlimited(b)) return '无限制'
  const parts: string[] = []
  if (b.tokens > 0) parts.push(`${formatTokens(b.tokens)} tokens`)
  if (b.costUsd > 0) parts.push(formatUsd(b.costUsd))
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
  used: { tokens: number; costUsd: number } | undefined,
): string {
  const lines: string[] = []
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
      ratios.push(`费用 ${formatUsd(used.costUsd)} / ${formatUsd(effective.costUsd)}（${pct}%）`)
    }
    if (ratios.length > 0) lines.push(`已用：${ratios.join(' · ')}`)
  } else if (used !== undefined) {
    lines.push(`已用：${formatTokens(used.tokens)} tokens · ${formatUsd(used.costUsd)}`)
  }

  lines.push('用法：/budget $5 · /budget 500k · /budget $5 500k · /budget off')
  return lines.join('\n')
}
