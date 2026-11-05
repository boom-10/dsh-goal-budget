/**
 * DeepSeek 官方价目与峰谷时段。
 *
 * 价格来源（官方页面，2026-11-05 核对）：
 *   美元：https://api-docs.deepseek.com/quick_start/pricing/
 *   人民币：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 单位：每百万 token。两套价目是官方分别公布的，不是同一个汇率换算的结果。
 *
 * 高峰时段（官方规则）：北京时间周一至周五、不含中国法定节假日，9:00–12:00 与 14:00–18:00。
 * 其余时段（含周末与法定节假日全天）为空闲时段。
 */
import { COVERED_YEARS, OFF_DAYS } from './holiday-calendar.ts'

/** 账户的计费币种。 */
export type Currency = 'USD' | 'CNY'

/** 峰谷时段。 */
export type Band = 'peak' | 'offPeak'

/** 计价支持的 DeepSeek 模型（旧名已折叠到这里）。 */
export type CanonicalModel = 'deepseek-flash' | 'deepseek-v4-pro'

/** 一个时段的三项单价，每百万 token。 */
export interface Rates {
  readonly cacheHit: number
  readonly cacheMiss: number
  readonly output: number
}

/** 官方价目。峰值是官方公布的数字，不是基础价乘以倍数得到的。 */
export const DEEPSEEK_TARIFFS: Readonly<Record<Currency, Readonly<Record<CanonicalModel, Readonly<Record<Band, Rates>>>>>> = {
  USD: {
    'deepseek-flash': {
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    },
    'deepseek-v4-pro': {
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
    },
  },
  CNY: {
    'deepseek-flash': {
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    'deepseek-v4-pro': {
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
  },
}

/**
 * 内置别名。
 *
 * - 官方模型名与官方说明的旧名（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`
 *   仍可调用，按 Flash 价格计费）。
 * - 官方模型版本名 `V4.1-Flash` 的常见写法：网关常拿它当模型 id。
 */
const BUILTIN_ALIASES: Readonly<Record<string, CanonicalModel>> = {
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'deepseek-v4.1-pro': 'deepseek-v4-pro',
}

/** 可计价的模型名 —— 配置里的别名只能指向其中之一。 */
export const CANONICAL_MODELS: readonly CanonicalModel[] = ['deepseek-flash', 'deepseek-v4-pro']

/** 用户配置的模型别名：日志里的模型名 → 计价模型。 */
export type ModelAliases = Readonly<Record<string, CanonicalModel>>

/**
 * 网关的命名分隔符。实测真实会话里出现过两种：`供应商/模型` 与 `网关--模型`。
 * 冒号也一并支持（`provider:model` 是常见写法）。
 */
const SEPARATORS: readonly string[] = ['/', '--', ':']

/**
 * 取最后一个分隔符之后的部分。
 *
 * `cm-ais/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
 * `ais/llm-gateway--deepseek-v4-flash` → `deepseek-v4-flash`（真实会话里的写法）
 */
function lastSegment(id: string): string {
  let end = -1
  for (const sep of SEPARATORS) {
    const at = id.lastIndexOf(sep)
    if (at !== -1) end = Math.max(end, at + sep.length - 1)
  }
  return end === -1 ? id : id.slice(end + 1)
}

/**
 * 路由里的模型名映射到计价模型。
 *
 * 依次尝试：原始名字 → 去掉供应商前缀 → 大小写不敏感。配置的别名优先于内置别名。
 * 都不认识时返回 undefined —— 调用方**不得**用别的模型的价格顶替（失败模式 #2）。
 *
 * @param id - `request/header` 里的模型 id，可以是带前缀的网关名字。
 * @param aliases - 用户配置的别名表，可覆盖内置。
 */
export function canonicalDeepSeekModel(id: string | undefined, aliases: ModelAliases = {}): CanonicalModel | undefined {
  if (id === undefined || id.length === 0) return undefined
  for (const name of [id, lastSegment(id)]) {
    for (const key of name === name.toLowerCase() ? [name] : [name, name.toLowerCase()]) {
      if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key]
      if (Object.prototype.hasOwnProperty.call(BUILTIN_ALIASES, key)) return BUILTIN_ALIASES[key]
    }
  }
  return undefined
}

const BEIJING_OFFSET_MS = 8 * 3_600_000
const OFF_DAY_SET: ReadonlySet<string> = new Set(OFF_DAYS)

/** 时刻对应的北京时间：星期（0 为周日）、日期、当日分钟数、年份。 */
function beijingClock(at: number): { weekday: number; date: string; minutes: number; year: number } {
  const bj = new Date(at + BEIJING_OFFSET_MS)
  return {
    weekday: bj.getUTCDay(),
    date: bj.toISOString().slice(0, 10),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    year: bj.getUTCFullYear(),
  }
}

/**
 * 某一时刻属于高峰还是空闲（北京时间）。
 *
 * 周末与列入 OFF_DAYS 的法定节假日全天为空闲；其余周一至周五，9:00–12:00 与 14:00–18:00 为高峰。
 */
export function bandAt(at: number): Band {
  const c = beijingClock(at)
  if (c.weekday === 0 || c.weekday === 6) return 'offPeak'
  if (OFF_DAY_SET.has(c.date)) return 'offPeak'
  const inPeak = (c.minutes >= 540 && c.minutes < 720) || (c.minutes >= 840 && c.minutes < 1080)
  return inPeak ? 'peak' : 'offPeak'
}

/** 节假日日历是否覆盖这一时刻所在的年份。不覆盖时假期判断退回星期规则，结果不保证准确。 */
export function calendarCovers(at: number): boolean {
  return COVERED_YEARS.includes(beijingClock(at).year)
}

/** 某模型、币种、时段的单价。 */
export function ratesFor(model: CanonicalModel, currency: Currency, band: Band): Rates {
  return DEEPSEEK_TARIFFS[currency][model][band]
}

/** 一次用量的 token 桶（输入未命中缓存、缓存命中、缓存写入、输出含推理）。 */
export interface PricedUsage {
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/**
 * 按 DeepSeek 计费口径算一次用量的费用。
 *
 * 三个输入桶并列；缓存写入 DeepSeek 不单独收费，按未命中价计；推理 token 已含在输出里，不重复加。
 */
export function costOfTariff(u: PricedUsage, r: Rates): number {
  return ((u.inputTokens + u.cacheWriteTokens) * r.cacheMiss + u.cacheReadTokens * r.cacheHit + u.outputTokens * r.output) / 1_000_000
}

/** 文本的稳定摘要（FNV-1a，0 到 999999），用于投影缓存版本。 */
export function digestOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 1_000_000
}
