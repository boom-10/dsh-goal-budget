/**
 * 投影的视图契约：客户端读到的形状、币种决定金额、未知币种不伪造费用、版本号。
 */
import assert from 'node:assert/strict'
import { createGoalBudgetProjection } from '../src/budget-projection.ts'
import { digestOf } from '../src/tariff.ts'
import { OFF_DAYS } from '../src/holiday-calendar.ts'

const bjTime = (hh: number) => Date.UTC(2026, 10, 3, hh - 8) // 2026-11-03 周二，北京时间
const usage = { inputTokens: 13_150_225, outputTokens: 712_512, cacheReadTokens: 651_227_392, cacheWriteTokens: 0 }
const deepseek = (time: number) => [
  { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } } },
  { type: 'assistant/message', time, data: { turn: 1, usage } },
]

function fold(def: ReturnType<typeof createGoalBudgetProjection>, events: Array<{ type: string; time?: number; data?: unknown }>) {
  return events.reduce((s, e) => def.apply(s, e), def.init())
}

// ── 1. 空状态：视图形状正确，且通过 viewSchema ──
{
  const def = createGoalBudgetProjection(() => 'USD')
  const view = def.wire.view(def.init())
  assert.equal(view.budget, null, '❌ 没设预算时 budget 应为 null')
  assert.equal(view.spent.currency, 'USD')
  assert.doesNotThrow(() => def.wire.viewSchema.parse(view), '❌ 空视图没通过 viewSchema')
  assert.deepEqual(Object.keys(view).sort(), ['budget', 'spent'], '❌ 客户端视图不得包含内部字段（路由、桶）')
}

// ── 2. 同一份用量，币种决定金额；非高峰与高峰相差 2 倍 ──
{
  const usd = createGoalBudgetProjection(() => 'USD')
  const off = usd.wire.view(fold(usd, deepseek(bjTime(12))))
  assert.ok(Math.abs(off.spent.costUsd - 4.353723) < 1e-5, `❌ 美元非高峰应为 $4.3537，得到 ${off.spent.costUsd}`)
  assert.equal(off.spent.currency, 'USD')

  const peak = usd.wire.view(fold(usd, deepseek(bjTime(10))))
  assert.ok(Math.abs(peak.spent.costUsd - 2 * 4.353723) < 1e-4, '❌ 北京时间 10:00（高峰）应为非高峰的 2 倍')

  const cny = createGoalBudgetProjection(() => 'CNY')
  const cnyView = cny.wire.view(fold(cny, deepseek(bjTime(12))))
  assert.ok(Math.abs(cnyView.spent.costUsd - 29.02482) < 1e-4, `❌ 人民币非高峰应为 ¥29.0248，得到 ${cnyView.spent.costUsd}`)
  assert.equal(cnyView.spent.currency, 'CNY')
  // 同一份日志，token 不随币种变化
  assert.equal(cnyView.spent.tokens, off.spent.tokens, '❌ token 不应随币种改变')
}

// ── 3. 币种未知：费用为 0、币种为 null，但 token 照常计入（不伪造金额）──
{
  const def = createGoalBudgetProjection(() => undefined)
  const view = def.wire.view(fold(def, deepseek(bjTime(12))))
  assert.equal(view.spent.costUsd, 0, '❌ 币种未知时不得伪造费用')
  assert.equal(view.spent.currency, null)
  assert.ok(view.spent.tokens > 0, '❌ token 仍应计入')
}

// ── 4. 不能计价的模型：列出名字，费用不计，token 计入 ──
{
  const def = createGoalBudgetProjection(() => 'USD')
  const s = fold(def, [
    { type: 'request/header', data: { header: { config: { provider: 'gateway', model: 'claude-sonnet' } } } },
    { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage } },
  ])
  const view = def.wire.view(s)
  assert.deepEqual([...view.spent.unpricedModels], ['gateway/claude-sonnet'], '❌ 应列出不能计价的模型')
  assert.equal(view.spent.costUsd, 0, '❌ 不能计价的模型不得算费用')
  assert.ok(view.spent.tokens > 0)
}

// ── 5. 没有用量的轮次：记为不可归因，不猜 ──
{
  const def = createGoalBudgetProjection(() => 'USD')
  const view = def.wire.view(fold(def, [{ type: 'assistant/message', time: bjTime(12), data: { turn: 1 } }]))
  assert.equal(view.spent.unbilledTurns, 1, '❌ 缺 usage 的轮次应计入 unbilledTurns')
}

// ── 6. /budget：金额带币种；off 清除 ──
{
  const def = createGoalBudgetProjection(() => 'CNY')
  const set = fold(def, [{ type: 'command/run', data: { name: 'budget', args: '¥30' } }])
  assert.deepEqual(def.wire.view(set).budget, { tokens: 0, costUsd: 30, costCurrency: 'CNY' }, '❌ ¥30 应记为人民币上限')
  const cleared = def.apply(set, { type: 'command/run', data: { name: 'budget', args: 'off' } })
  assert.equal(def.wire.view(cleared).budget, null, '❌ off 应清除上限')
}

// ── 7. 框架契约：不关心的事件必须返回同一个引用 ──
{
  const def = createGoalBudgetProjection()
  const s = def.init()
  assert.equal(def.apply(s, { type: 'turn/start', data: { turn: 1 } }), s, '❌ 不关心的事件必须返回同一个引用')
}

// ── 8. 严格模式：多余字段被拒绝 ──
{
  const def = createGoalBudgetProjection()
  assert.throws(() => def.wire.viewSchema.parse({ ...def.wire.view(def.init()), extra: 1 }), '❌ 多余字段应被拒绝')
}

// ── 9. 版本号：绑定官方日历的内容，日历变了旧缓存必须重建 ──
{
  const def = createGoalBudgetProjection()
  assert.equal(def.stateVersion, 6_000_000 + digestOf(OFF_DAYS.join(',')), '❌ 版本号应绑定日历内容')
}

console.log('✅ projection-view.spec.ts 全部通过（9 组断言）')
