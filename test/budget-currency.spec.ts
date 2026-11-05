/**
 * `/budget` 的人民币金额：解析、显示、不允许重复写金额。
 */
import assert from 'node:assert/strict'
import { describeBudget, formatMoney, parseBudgetCommand } from '../src/budget-command.ts'

const parsed = (input: string) => parseBudgetCommand(input)

// ── 1. 人民币的各种写法 ──
for (const input of ['¥30', '30¥', '30元', 'cny30', '30cny', 'CNY30']) {
  const r = parsed(input)
  assert.equal(r.kind, 'set', `❌ ${input} 应可解析`)
  if (r.kind === 'set') {
    assert.equal(r.budget.costUsd, 30, `❌ ${input} 金额应为 30`)
    assert.equal(r.budget.costCurrency, 'CNY', `❌ ${input} 应为人民币`)
    assert.equal(r.label, '¥30', `❌ ${input} 的标签应为 ¥30`)
  }
}

// ── 2. 美元保持原样（缺省也是美元）──
{
  const r = parsed('$5')
  assert.ok(r.kind === 'set' && r.budget.costCurrency === 'USD' && r.label === '$5', '❌ $5 应为美元')
  const bare = parsed('5$')
  assert.ok(bare.kind === 'set' && bare.budget.costCurrency === 'USD', '❌ 5$ 应为美元')
}

// ── 3. 金额只能写一次，哪怕币种不同 ──
{
  const r = parsed('$5 ¥30')
  assert.equal(r.kind, 'invalid', '❌ 美元和人民币不能同时写')
  if (r.kind === 'invalid') assert.match(r.reason, /只能写一次/)
}

// ── 4. 显示带币种符号 ──
assert.equal(formatMoney(0.5, 'CNY'), '¥0.500', '❌ 人民币小额显示')
assert.equal(formatMoney(0, 'CNY'), '¥0', '❌ 零金额显示')
assert.equal(formatMoney(4.3537), '$4.35', '❌ 缺省币种应为美元')
assert.match(describeBudget({ tokens: 0, costUsd: 30, wallClockMs: 0, costCurrency: 'CNY' }), /¥30/, '❌ 预算描述应带人民币符号')

console.log('✅ budget-currency.spec.ts 全部通过（4 组断言）')
