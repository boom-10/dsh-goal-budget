/**
 * 计价与预算判定（纯函数）。
 *
 * 口径以 DSH 的 TokenUsage 契约为准（packages/llm/llm/src/types.ts:177）：
 * inputTokens 只含未命中缓存的输入，缓存命中在 cacheReadTokens，三者并列。
 * reasoningTokens 是 outputTokens 的子集（token-meter/tests/turn-usage.spec.ts 把
 * 「reasoning 超过 output」列为非法）。
 *
 * 价格按会话当前的模型查，并按事件时间判断是否高峰（官方规则，UTC）。
 */
import assert from 'node:assert/strict'
import {
  addUsage, billedTokensOf, checkBudget, costOf, DEFAULT_PRICES, findPriceByModel, isPeak,
  pricingAt, totalsOf,
  type GoalSpend, type Pricing, type PriceEntry, type TurnSpend,
} from '../src/accounting.ts'
import { createGoalBudgetProjection } from '../src/budget-projection.ts'

const P: Pricing = { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 }
const M = 1e6
const H = 3_600_000
const E: PriceEntry = {
  model: 'deepseek-flash', inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003,
  peakMultiplier: 2, holidays: [],
}
// 2026-11-03 是周二（下面断言了星期），用来构造高峰与非高峰时刻。
const TUE = Date.UTC(2026, 10, 3)
const SAT = Date.UTC(2026, 10, 7)
assert.equal(new Date(TUE).getUTCDay(), 2, '测试前提：TUE 应为周二')
assert.equal(new Date(SAT).getUTCDay(), 6, '测试前提：SAT 应为周六')

// 真实会话 2d3becaf 的合计
const REAL = { inputTokens: 13_150_225, outputTokens: 712_512, cacheReadTokens: 651_227_392, cacheWriteTokens: 0 }

// ── 1. 缓存命中按缓存价计，且不从输入里扣 ──
{
  const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000 }
  const expected = (1_000_000 / M) * 0.15 + (900_000 / M) * 0.003
  assert.ok(Math.abs(costOf(u, P) - expected) < 1e-12, `❌ 应为 ${expected}，得到 ${costOf(u, P)}`)
  const subtracted = (100_000 / M) * 0.15 + (900_000 / M) * 0.003
  assert.ok(costOf(u, P) > subtracted, '❌ 从输入里扣掉了缓存（0.5.0 的错误口径）')
}

// ── 2. 缓存写入按未命中价计 ──
assert.ok(Math.abs(costOf({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 500_000 }, P) - (500_000 / M) * 0.15) < 1e-12,
  '❌ 缓存写入应按未命中价计')

// ── 3. 推理 token 是输出的子集，不重复计费 ──
assert.equal(
  costOf({ inputTokens: 0, outputTokens: 1000, reasoningTokens: 1000 }, P),
  costOf({ inputTokens: 0, outputTokens: 1000 }, P),
  '❌ 推理 token 被加在输出之外，重复计费',
)

// ── 4. addUsage 累加；usage 缺失标为不可归因 ──
{
  const zero: TurnSpend = {
    turn: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costUsd: 0, attributable: true,
  }
  const a = addUsage(zero, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }, P)
  const b = addUsage(a, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 150 }, P)
  assert.equal(b.inputTokens, 300, '❌ 输入 token 应累加')
  assert.equal(b.cacheReadTokens, 200, '❌ 缓存 token 应累加')
  assert.equal(b.attributable, true)
  assert.equal(addUsage(b, undefined, P).attributable, false, '❌ usage 缺失必须显式标为不可归因')
}

// ── 5. 预算判定：谁先到算谁 ──
{
  const spend = (costUsd: number, tokens: number): GoalSpend => ({
    goalId: 'g', unattributableTurns: 0,
    rounds: new Map([[1, {
      turn: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, costUsd, attributable: true,
    }]]),
  })
  const byCost = checkBudget(spend(6, 100), { tokens: 1_000_000, costUsd: 5 })
  assert.equal(byCost.exceeded, true)
  if (byCost.exceeded) assert.equal(byCost.kind, 'costUsd', '❌ 费用先超就该报 costUsd')
  const byTokens = checkBudget(spend(1, 2_000_000), { tokens: 1_000_000, costUsd: 5 })
  assert.equal(byTokens.exceeded, true)
  if (byTokens.exceeded) assert.equal(byTokens.kind, 'tokens', '❌ token 先超就该报 tokens')
  assert.equal(checkBudget(spend(1, 100), { tokens: 1_000_000, costUsd: 5 }).exceeded, false)
  assert.equal(checkBudget(spend(999, 999_999_999), {}).exceeded, false, '❌ 未配预算不应阻断')
}

// ── 6. token 口径与宿主「用量」一致 ──
{
  assert.equal(billedTokensOf({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, reasoningTokens: 5 }), 160,
    '❌ 应为 100 + 50 + 10，推理不另加')
  const round = (turn: number, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number }): TurnSpend => ({
    turn, cacheWriteTokens: 0, costUsd: 0, attributable: true, ...usage,
  })
  const s: GoalSpend = {
    goalId: 'g', unattributableTurns: 0,
    rounds: new Map([
      [1, round(1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, reasoningTokens: 5 })],
      [2, round(2, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 0 })],
    ]),
  }
  assert.equal(totalsOf(s).tokens, 380, '❌ 合计应为 160 + 220')
}

// ── 7. ★ 真实会话回归（非高峰）──
{
  const expected = (13_150_225 * 0.15 + 651_227_392 * 0.003 + 712_512 * 0.6) / M
  assert.ok(Math.abs(costOf(REAL, P) - expected) < 1e-9, `❌ 应为 $${expected.toFixed(4)}，得到 $${costOf(REAL, P).toFixed(4)}`)
  assert.ok(Math.abs(expected - 4.353723) < 1e-5, '❌ 非高峰参考值应为 $4.3537')
}

// ── 8. 高峰判定：UTC 01–04、06–10 点，周一至周五，节假日全天非高峰 ──
{
  assert.equal(isPeak(TUE + 1 * H, []), true, '❌ 周二 01:00 UTC 应为高峰')
  assert.equal(isPeak(TUE + 3 * H, []), true, '❌ 周二 03:00 UTC 应为高峰')
  assert.equal(isPeak(TUE + 4 * H, []), false, '❌ 04:00 UTC 起应为非高峰（窗口是 [1,4)）')
  assert.equal(isPeak(TUE + 7 * H, []), true, '❌ 周二 07:00 UTC 应为高峰')
  assert.equal(isPeak(TUE + 10 * H, []), false, '❌ 10:00 UTC 起应为非高峰')
  assert.equal(isPeak(TUE + 12 * H, []), false, '❌ 中午 12:00 UTC 应为非高峰')
  assert.equal(isPeak(SAT + 2 * H, []), false, '❌ 周六不分时段')
  assert.equal(isPeak(TUE + 2 * H, ['2026-11-03']), false, '❌ 列入节假日的日期全天非高峰')
}

// ── 9. 单价随时段变化：高峰为倍数，缺时间按非高峰 ──
{
  const peak = pricingAt(E, TUE + 2 * H)
  assert.equal(peak.inputPerMillion, 0.3, '❌ 高峰未命中输入应为 2 倍')
  assert.equal(peak.outputPerMillion, 1.2, '❌ 高峰输出应为 2 倍')
  assert.equal(peak.cacheReadPerMillion, 0.006, '❌ 高峰缓存命中应为 2 倍')
  assert.equal(pricingAt(E, TUE + 12 * H).inputPerMillion, 0.15, '❌ 非高峰应为基础价')
  assert.equal(pricingAt(E, undefined).inputPerMillion, 0.15, '❌ 缺时间应按非高峰计')
  const flat = { ...E, peakMultiplier: 1 }
  assert.equal(pricingAt(flat, TUE + 2 * H).inputPerMillion, 0.15, '❌ peakMultiplier 为 1 时不分时段')
}

// ── 10. 按模型查价：只按模型 id，查不到就是 undefined（不顶替）──
{
  assert.equal(findPriceByModel(DEFAULT_PRICES, 'deepseek-flash')?.model, 'deepseek-flash', '❌ 官方默认价应能查到')
  assert.equal(findPriceByModel(DEFAULT_PRICES, 'claude-sonnet'), undefined, '❌ 其他模型不得套用 DeepSeek 价格')
  assert.equal(findPriceByModel(DEFAULT_PRICES, undefined), undefined, '❌ 没有路由时不得猜价格')
}

// ── 11. ★ 投影按会话当前模型计价，换模型后未定价的模型显式列出 ──
{
  const def = createGoalBudgetProjection([E])
  const usage1 = { inputTokens: 1_000_000, outputTokens: 10_000, cacheReadTokens: 500_000 }
  const usage2 = { inputTokens: 2_000_000, outputTokens: 20_000 }
  let s = def.init()
  s = def.apply(s, { type: 'request/header', data: { header: { config: { provider: 'a', model: 'deepseek-flash' } } } })
  s = def.apply(s, { type: 'assistant/message', time: TUE + 2 * H, data: { turn: 1, usage: usage1 } })
  const costDeepseekPeak = costOf(usage1, pricingAt(E, TUE + 2 * H))
  assert.ok(Math.abs(s.spent.costUsd - costDeepseekPeak) < 1e-12, '❌ 高峰时段的 DeepSeek 用量应按 2 倍计价')

  s = def.apply(s, { type: 'request/header', data: { header: { config: { provider: 'a', model: 'claude-sonnet' } } } })
  s = def.apply(s, { type: 'assistant/message', time: TUE + 12 * H, data: { turn: 2, usage: usage2 } })
  assert.ok(Math.abs(s.spent.costUsd - costDeepseekPeak) < 1e-12, '❌ 未定价模型的费用不得计入（不能用 DeepSeek 价格顶替）')
  assert.equal(s.spent.tokens, billedTokensOf(usage1) + billedTokensOf(usage2), '❌ 未定价模型的 token 仍应计入')
  assert.deepEqual([...s.spent.unpricedModels], ['a/claude-sonnet'], '❌ 应列出未定价的模型')

  const view = def.wire.view(s)
  assert.equal('route' in view, false, '❌ 客户端视图不应包含内部路由')
}

// ── 12. ★ 投影与宿主算同一个数（一个数字，一个来源）──
{
  const def = createGoalBudgetProjection([E])
  let s = def.init()
  s = def.apply(s, { type: 'request/header', data: { header: { config: { provider: 'a', model: 'deepseek-flash' } } } })
  s = def.apply(s, { type: 'assistant/message', time: TUE + 12 * H, data: { turn: 1, usage: REAL } })
  assert.equal(s.spent.tokens, billedTokensOf(REAL), '❌ 投影的 token 与宿主口径不一致')
  assert.ok(Math.abs(s.spent.costUsd - costOf(REAL, P)) < 1e-12, '❌ 投影的非高峰花费与宿主 costOf 不一致')
  assert.equal(s.spent.tokens, 665_090_129, '❌ 合计 token 应为 665,090,129')
}

// ── 13. ★ 真实会话在高峰时段的花费 = 非高峰的 2 倍 ──
{
  const peakCost = costOf(REAL, pricingAt(E, TUE + 2 * H))
  assert.ok(Math.abs(peakCost - 2 * 4.353723126) < 1e-9, `❌ 高峰应为 2 倍，得到 ${peakCost}`)
}

// ── 14. 价格变了，投影版本号必须变，否则旧缓存会被当成新的 ──
{
  const v1 = createGoalBudgetProjection([E]).stateVersion
  const v2 = createGoalBudgetProjection([{ ...E, inputPerMillion: 0.2 }]).stateVersion
  assert.notEqual(v1, v2, '❌ 价格表变了，stateVersion 没变，旧缓存不会重建')
  assert.ok(v1 >= 5_000_000, '❌ stateVersion 应落在本版本的命名空间内')
}

console.log('✅ accounting.spec.ts 全部通过（14 组断言）')
console.log('   - 缓存按缓存价计且不从输入扣；缓存写入按未命中价；推理不重复计费')
console.log('   - 预算判定「谁先到算谁」两个方向；token 口径与宿主「用量」一致')
console.log('   - 真实会话非高峰 $4.3537，高峰为 2 倍')
console.log('   - 高峰判定与单价随时段变化；按模型查价，不顶替')
console.log('   - 投影按会话当前模型计价，未定价模型显式列出，客户端视图不含路由')
console.log('   - 投影与宿主算同一个数；价格变了版本号必变')
