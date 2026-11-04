/**
 * 计价与预算判定 —— 纯函数。
 *
 * ## 为什么必须有这个 spec
 *
 * 变异测试发现：把 `costOf` 里的 `inputTokens - cacheReadTokens` 改成不扣，
 * 原有测试**一条都没红**。因为那些测试的数据 `cacheReadTokens` 全是 0，
 * 而缓存计价恰恰是这套东西最容易错的地方（单价差 50 倍）。
 *
 * 这里专门喂含缓存的真实形状。
 */

import assert from 'node:assert/strict'
import { addUsage, checkBudget, costOf, totalsOf, type GoalSpend } from '../src/accounting.ts'

const P = { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 }
const M = 1e6

// ── 1. ★ 缓存必须从 input 里扣掉，否则重复计费 ──
{
  const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000 }
  const expected = (100_000 / M) * 0.15 + (900_000 / M) * 0.003
  const wrong = (1_000_000 / M) * 0.15 + (900_000 / M) * 0.003
  assert.ok(
    Math.abs(costOf(u, P) - expected) < 1e-12,
    `❌ 未扣缓存：得到 ${costOf(u, P)}，应为 ${expected}（不扣会是 ${wrong}）`,
  )
  assert.ok(costOf(u, P) < wrong, '❌ 不扣缓存的结果必须更大 —— 若不然说明这条断言没在测东西')
}

// ── 2. cacheRead > input 时不能变负数（逐条 max(0)）──
{
  const u = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 5000 }
  const expected = (5000 / M) * 0.003
  assert.ok(Math.abs(costOf(u, P) - expected) < 1e-12, `❌ 负的 freshInput 应归零，得到 ${costOf(u, P)}`)
}

// ── 3. reasoning token 计入 output 侧 ──
{
  const base = { inputTokens: 0, outputTokens: 1000 }
  const withReasoning = { ...base, reasoningTokens: 1000 }
  assert.ok(costOf(withReasoning, P) > costOf(base, P), '❌ reasoning token 应计入成本')
}

// ── 4. addUsage 累加且 usage 缺失时标为不可归因 ──
{
  const zero = { turn: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, attributable: true }
  const a = addUsage(zero, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }, P)
  const b = addUsage(a, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 150 }, P)
  assert.equal(b.inputTokens, 300, '❌ 输入 token 应累加')
  assert.equal(b.cacheReadTokens, 200, '❌ 缓存 token 应累加')
  assert.equal(b.attributable, true)
  const c = addUsage(b, undefined, P)
  assert.equal(c.attributable, false, '❌ usage 缺失必须显式标为不可归因，不能猜')
}

// ── 5. ★ 预算判定：谁先到算谁 ──
{
  const spend = (costUsd: number, tokens: number): GoalSpend => ({
    goalId: 'g',
    unattributableTurns: 0,
    rounds: new Map([[1, {
      turn: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, costUsd, attributable: true,
    }]]),
  })

  // 费用先到
  const byCost = checkBudget(spend(6, 100), { tokens: 1_000_000, costUsd: 5 })
  assert.equal(byCost.exceeded, true)
  if (byCost.exceeded) assert.equal(byCost.kind, 'costUsd', '❌ 费用先超就该报 costUsd')

  // token 先到
  const byTokens = checkBudget(spend(1, 2_000_000), { tokens: 1_000_000, costUsd: 5 })
  assert.equal(byTokens.exceeded, true)
  if (byTokens.exceeded) assert.equal(byTokens.kind, 'tokens', '❌ token 先超就该报 tokens')

  // 都没到
  const ok = checkBudget(spend(1, 100), { tokens: 1_000_000, costUsd: 5 })
  assert.equal(ok.exceeded, false)
  assert.ok(ok.ratio > 0 && ok.ratio < 1, '❌ 未超时应给出 0–1 之间的比例')

  // 没配预算 → 永不超
  assert.equal(checkBudget(spend(999, 999_999_999), {}).exceeded, false, '❌ 未配预算不应阻断')
}

// ── 6. totalsOf ──
{
  const s: GoalSpend = {
    goalId: 'g', unattributableTurns: 0,
    rounds: new Map([
      [1, { turn: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.1, attributable: true }],
      [2, { turn: 3, inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 5, costUsd: 0.2, attributable: true }],
    ]),
  }
  const t = totalsOf(s)
  assert.equal(t.rounds, 2, '❌ 轮数应为 2')
  assert.equal(t.tokens, 335, `❌ token 合计应为 335，得到 ${t.tokens}`)
  assert.ok(Math.abs(t.costUsd - 0.3) < 1e-12, '❌ 费用应累加')
}

console.log('✅ accounting.spec.ts 全部通过（6 组断言）')
console.log('   - 缓存从 input 扣掉，且不会变负')
console.log('   - reasoning 计入')
console.log('   - usage 缺失标为不可归因')
console.log('   - 「谁先到算谁」两个方向都测了')
console.log('   - 未配预算永不阻断')
