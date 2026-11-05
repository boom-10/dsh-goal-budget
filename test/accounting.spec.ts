/**
 * 计价的会计部分（纯函数）：三个输入桶并列、推理不重复、预算的先到先算。
 * 具体的官方价目与峰谷时段在 tariff.spec.ts。
 */
import assert from 'node:assert/strict'
import { addUsage, billedTokensOf, checkBudget, costOf, totalsOf, type GoalSpend, type Pricing, type TurnSpend } from '../src/accounting.ts'

const P: Pricing = { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 }
const M = 1e6

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

console.log('✅ accounting.spec.ts 全部通过（6 组断言）')
