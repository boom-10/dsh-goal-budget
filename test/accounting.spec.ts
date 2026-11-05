/**
 * 计价与预算判定（纯函数）。
 *
 * 口径以 DSH 的 TokenUsage 契约为准（packages/llm/llm/src/types.ts:177）：
 * inputTokens 只含未命中缓存的输入，缓存命中在 cacheReadTokens，三者并列。
 * reasoningTokens 是 outputTokens 的子集（token-meter/tests/turn-usage.spec.ts 把
 * 「reasoning 超过 output」列为非法）。
 *
 * 0.5.0 到 0.8.0 的计价错了，就是因为把缓存从输入里扣掉了。本文件的断言钉住正确口径。
 */
import assert from 'node:assert/strict'
import {
  addUsage, billedTokensOf, checkBudget, costOf, totalsOf,
  type GoalSpend, type Pricing, type TurnSpend,
} from '../src/accounting.ts'
import { createGoalBudgetProjection } from '../src/budget-projection.ts'

const P: Pricing = { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 }
const M = 1e6

// ── 1. 缓存命中按缓存价计，且不从输入里扣 ──
{
  const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000 }
  const expected = (1_000_000 / M) * 0.15 + (900_000 / M) * 0.003
  assert.ok(Math.abs(costOf(u, P) - expected) < 1e-12, `❌ 应为 ${expected}，得到 ${costOf(u, P)}`)
  // 0.5.0 的错误：从输入里扣掉缓存，结果更小
  const subtracted = (100_000 / M) * 0.15 + (900_000 / M) * 0.003
  assert.ok(costOf(u, P) > subtracted, '❌ 从输入里扣掉了缓存（0.5.0 的错误口径）')
}

// ── 2. 缓存写入按未命中价计 ──
{
  const u = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 500_000 }
  assert.ok(Math.abs(costOf(u, P) - (500_000 / M) * 0.15) < 1e-12, '❌ 缓存写入应按未命中价计')
}

// ── 3. 推理 token 是输出的子集，不重复计费 ──
{
  const plain = costOf({ inputTokens: 0, outputTokens: 1000 }, P)
  const withReasoning = costOf({ inputTokens: 0, outputTokens: 1000, reasoningTokens: 1000 }, P)
  assert.equal(withReasoning, plain, '❌ 推理 token 被加在输出之外，重复计费')
}

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

// ── 6. token 口径与宿主「用量」一致：三个输入桶加输出，推理不另加 ──
{
  assert.equal(
    billedTokensOf({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, reasoningTokens: 5 }),
    160,
    '❌ 应为 100 + 50 + 10，推理不另加',
  )
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

// ── 7. ★ 真实会话回归：会话 2d3becaf 的合计 ──
// 数据：未命中输入 13,150,225；缓存命中 651,227,392；输出 712,512。
// 缓存命中约为未命中输入的 50 倍，这已经证明 inputTokens 不含缓存（否则总输入不可能更小）。
{
  const u = { inputTokens: 13_150_225, outputTokens: 712_512, cacheReadTokens: 651_227_392, cacheWriteTokens: 0 }
  const expected = (13_150_225 * 0.15 + 651_227_392 * 0.003 + 712_512 * 0.6) / M
  assert.ok(Math.abs(costOf(u, P) - expected) < 1e-9, `❌ 应为 $${expected.toFixed(4)}，得到 $${costOf(u, P).toFixed(4)}`)
  assert.ok(Math.abs(expected - 4.353723) < 1e-5, '❌ 参考值应为 $4.3537')
}

// ── 8. ★ 投影与宿主算同一个数（一个数字，一个来源）──
{
  const def = createGoalBudgetProjection(P)
  assert.equal(def.stateVersion, 3, '❌ 口径变了，stateVersion 必须递增，否则旧缓存会被当成新的')
  const usage = { inputTokens: 13_150_225, outputTokens: 712_512, cacheReadTokens: 651_227_392, cacheWriteTokens: 0 }
  const folded = def.apply(def.init(), { type: 'assistant/message', data: { turn: 1, usage } })
  assert.equal(folded.spent.tokens, billedTokensOf(usage), '❌ 投影的 token 与宿主口径不一致')
  assert.ok(Math.abs(folded.spent.costUsd - costOf(usage, P)) < 1e-12, '❌ 投影的花费与宿主 costOf 不一致')
  assert.equal(folded.spent.tokens, 665_090_129, '❌ 合计 token 应为 665,090,129')
}

console.log('✅ accounting.spec.ts 全部通过（8 组断言）')
console.log('   - 缓存命中按缓存价计，且不从输入里扣')
console.log('   - 缓存写入按未命中价计；推理不重复计费')
console.log('   - usage 缺失标为不可归因；预算「谁先到算谁」两个方向')
console.log('   - token 口径与宿主「用量」一致')
console.log('   - 真实会话 2d3becaf 回归：$4.3537')
console.log('   - 投影与宿主算同一个数，stateVersion 已递增')
