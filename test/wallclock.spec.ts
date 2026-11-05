/**
 * 时间维度（wallClockMs）：解析、计时、判定。
 *
 * 三条不变式：
 *  1. `m` 仍然是「百万 token」，分钟必须写 `min`（否则同一个字母两种含义）。
 *  2. 计时是各轮跨度之和：轮与轮之间的空闲（比如暂停一夜）不计入。
 *  3. 时间超限要阻断，而且报的是 wallClockMs 这一维。
 */
import assert from 'node:assert/strict'
import { parseBudgetCommand, formatDuration } from '../src/budget-command.ts'
import { openRound, addUsage, totalsOf, checkBudget, type TurnSpend, type GoalSpend } from '../src/accounting.ts'

const P = { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.003 }
const MIN = 60_000

// ── 1. 解析 ──
{
  const a = parseBudgetCommand('30min')
  assert.equal(a.kind, 'set')
  if (a.kind === 'set') assert.equal(a.budget.wallClockMs, 30 * MIN, '30min 应为 1800000 ms')

  const b = parseBudgetCommand('2h')
  if (b.kind === 'set') assert.equal(b.budget.wallClockMs, 2 * 3_600_000, '2h 应为 7200000 ms')

  const c = parseBudgetCommand('45s')
  if (c.kind === 'set') assert.equal(c.budget.wallClockMs, 45_000, '45s 应为 45000 ms')

  // ★ m 必须仍是 token，不能被误解成分钟
  const m = parseBudgetCommand('1.5m')
  assert.equal(m.kind, 'set')
  if (m.kind === 'set') {
    assert.equal(m.budget.tokens, 1_500_000, '1.5m 必须仍是 150 万 token')
    assert.equal(m.budget.wallClockMs, 0, '1.5m 不能顺带设了时间上限')
  }

  // 组合：金额 + 时长
  const combo = parseBudgetCommand('$5 30min')
  if (combo.kind === 'set') {
    assert.equal(combo.budget.costUsd, 5)
    assert.equal(combo.budget.wallClockMs, 30 * MIN)
  } else {
    assert.fail('$5 30min 应解析成功')
  }

  // 同一维度只能写一次
  assert.equal(parseBudgetCommand('10min 20min').kind, 'invalid', '两个时长应被拒绝')
}

// ── 2. 格式化 ──
assert.equal(formatDuration(30 * MIN), '30min')
assert.equal(formatDuration(2 * 3_600_000), '2h')

// ── 3. 计时：各轮跨度之和，空闲不计 ──
{
  const fresh = (turn: number): TurnSpend => ({
    turn, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costUsd: 0, attributable: true,
  })
  const spend: GoalSpend = { goalId: 'g', rounds: new Map(), unattributableTurns: 0 }

  // 第 1 轮：跑了 10 分钟
  let r1 = openRound(fresh(1), 1_000_000)
  r1 = addUsage(r1, { inputTokens: 100, outputTokens: 10 }, P, 1_000_000 + 10 * MIN)
  spend.rounds.set(1, r1)

  // 第 2 轮：隔了一夜才开始，又跑了 5 分钟
  const dayLater = 1_000_000 + 24 * 60 * MIN
  let r2 = openRound(fresh(2), dayLater)
  r2 = addUsage(r2, { inputTokens: 100, outputTokens: 10 }, P, dayLater + 5 * MIN)
  spend.rounds.set(2, r2)

  const total = totalsOf(spend).wallClockMs
  assert.equal(total, 15 * MIN, `❌ 应为 15 分钟（空闲的一整天不计），得到 ${total / MIN} 分钟`)
}

// ── 4. openRound 幂等：已开始的轮不会被后来的事件改写起点 ──
{
  const t0 = openRound({
    turn: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, costUsd: 0, attributable: true,
  }, 500)
  const again = openRound(t0, 9_999)
  assert.equal(again.startedAt, 500, '❌ 起点被后来的事件改写了')
}

// ── 5. 超时阻断，且报的是时间维度 ──
{
  const spend: GoalSpend = {
    goalId: 'g', unattributableTurns: 0,
    rounds: new Map([[1, {
      turn: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, costUsd: 0, attributable: true, startedAt: 0, endedAt: 31 * MIN,
    }]]),
  }
  const v = checkBudget(spend, { wallClockMs: 30 * MIN })
  assert.equal(v.exceeded, true, '❌ 31 分钟应超过 30 分钟上限')
  if (v.exceeded) assert.equal(v.kind, 'wallClockMs', '❌ 报的维度应是 wallClockMs')
}

console.log('wallclock.spec.ts 全部通过（5 组断言）')
console.log('   - 30min / 2h / 45s 解析正确；1.5m 仍是 token')
console.log('   - 计时是各轮跨度之和，空闲一整天不计')
console.log('   - openRound 幂等')
console.log('   - 超时阻断且报 wallClockMs 维度')
