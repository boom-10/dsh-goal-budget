/**
 * 投影的视图契约：客户端读到的形状、币种决定金额、未知币种不伪造费用、版本号。
 */
import assert from 'node:assert/strict'
import { createGoalBudgetProjection } from '../src/budget-projection.ts'
import type { ConfiguredPrice } from '../src/tariff.ts'
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
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
  const view = def.wire.view(def.init())
  assert.equal(view.budget, null, '❌ 没设预算时 budget 应为 null')
  assert.equal(view.spent.currency, 'USD')
  assert.doesNotThrow(() => def.wire.viewSchema.parse(view), '❌ 空视图没通过 viewSchema')
  assert.deepEqual(Object.keys(view).sort(), ['budget', 'spent'], '❌ 客户端视图不得包含内部字段（路由、桶）')
}

// ── 2. 同一份用量，币种决定金额；非高峰与高峰相差 2 倍 ──
{
  const usd = createGoalBudgetProjection({ currency: () => 'USD' })
  const off = usd.wire.view(fold(usd, deepseek(bjTime(12))))
  assert.ok(Math.abs(off.spent.costUsd - 4.353723) < 1e-5, `❌ 美元非高峰应为 $4.3537，得到 ${off.spent.costUsd}`)
  assert.equal(off.spent.currency, 'USD')

  const peak = usd.wire.view(fold(usd, deepseek(bjTime(10))))
  assert.ok(Math.abs(peak.spent.costUsd - 2 * 4.353723) < 1e-4, '❌ 北京时间 10:00（高峰）应为非高峰的 2 倍')

  const cny = createGoalBudgetProjection({ currency: () => 'CNY' })
  const cnyView = cny.wire.view(fold(cny, deepseek(bjTime(12))))
  assert.ok(Math.abs(cnyView.spent.costUsd - 29.02482) < 1e-4, `❌ 人民币非高峰应为 ¥29.0248，得到 ${cnyView.spent.costUsd}`)
  assert.equal(cnyView.spent.currency, 'CNY')
  // 同一份日志，token 不随币种变化
  assert.equal(cnyView.spent.tokens, off.spent.tokens, '❌ token 不应随币种改变')
}

// ── 3. 币种未知：费用为 0、币种为 null，但 token 照常计入（不伪造金额）──
{
  const def = createGoalBudgetProjection({ currency: () => undefined })
  const view = def.wire.view(fold(def, deepseek(bjTime(12))))
  assert.equal(view.spent.costUsd, 0, '❌ 币种未知时不得伪造费用')
  assert.equal(view.spent.currency, null)
  assert.ok(view.spent.tokens > 0, '❌ token 仍应计入')
}

// ── 4. 不能计价的模型：列出名字，费用不计，token 计入 ──
{
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
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
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
  const view = def.wire.view(fold(def, [{ type: 'assistant/message', time: bjTime(12), data: { turn: 1 } }]))
  assert.equal(view.spent.unbilledTurns, 1, '❌ 缺 usage 的轮次应计入 unbilledTurns')
}

// ── 6. /budget：金额带币种；off 清除 ──
{
  const def = createGoalBudgetProjection({ currency: () => 'CNY' })
  const set = fold(def, [{ type: 'command/run', data: { name: 'budget', args: '¥30' } }])
  assert.deepEqual(def.wire.view(set).budget, { tokens: 0, costUsd: 30, costCurrency: 'CNY' }, '❌ ¥30 应记为人民币上限')
  const cleared = def.apply(set, { type: 'command/run', data: { name: 'budget', args: 'off' } })
  assert.equal(def.wire.view(cleared).budget, null, '❌ off 应清除上限')
}

// ── 6b. 网关线路：模型名带 `供应商/` 前缀，去掉前缀后按 Flash 计价 ──
{
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
  const s = fold(def, [
    { type: 'request/header', data: { header: { config: { provider: 'magpie-responses', model: 'cm-ais/deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage } },
  ])
  const view = def.wire.view(s)
  assert.ok(Math.abs(view.spent.costUsd - 4.353723) < 1e-5, `❌ 带前缀的网关模型应能计价，得到 ${view.spent.costUsd}`)
  assert.deepEqual([...view.spent.unpricedModels], [], '❌ 不应列为不计价')
}

// ── 6c. 别名表能覆盖网关的自定义名字 ──
{
  const def = createGoalBudgetProjection({ currency: () => 'USD', aliases: { 'vendor/my-flash': 'deepseek-flash' } })
  const s = fold(def, [
    { type: 'request/header', data: { header: { config: { provider: 'gateway', model: 'vendor/my-flash' } } } },
    { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage } },
  ])
  assert.ok(def.wire.view(s).spent.costUsd > 0, '❌ 别名应让自定义模型名可计价')
}

// ── 6d. ★ 关闭峰谷（网关口径）：同一份高峰日志金额减半 ──
//     实测依据：网关上 197 条 deepseek 记录全部落在高峰时段，收费却与非高峰价逐条精确吻合。
{
  const official = createGoalBudgetProjection({ currency: () => 'USD' })
  const gateway = createGoalBudgetProjection({ currency: () => 'USD', peakPricing: false })
  const at = bjTime(10) // 北京时间 10:00，高峰
  const a = official.wire.view(fold(official, deepseek(at))).spent.costUsd
  const b = gateway.wire.view(fold(gateway, deepseek(at))).spent.costUsd
  assert.ok(Math.abs(a - 2 * b) < 1e-9, `❌ 关闭峰谷后应恰好减半：官方口径 ${a}，网关口径 ${b}`)
  assert.ok(Math.abs(b - 4.353723) < 1e-5, `❌ 网关口径应按非高峰价：${b}`)
}

// ── 6e. ★ 分模型明细：让「哪部分算了钱、哪部分没算」一眼可见 ──
//      OBSERVED 的用户反馈：面板只给总数，看不出 DeepSeek 那部分到底有没有计价。
{
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
  let s = def.init()
  s = def.apply(s, { type: 'request/header', data: { header: { config: { provider: 'magpie-responses', model: 'cm-ais/deepseek-v4.1-flash' } } } })
  s = def.apply(s, { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage } })
  s = def.apply(s, { type: 'request/header', data: { header: { config: { provider: 'magpie-anthropic', model: 'cm-ais/claude-haiku-5-5' } } } })
  s = def.apply(s, { type: 'assistant/message', time: bjTime(12), data: { turn: 2, usage: { inputTokens: 1_000_000, outputTokens: 0 } } })
  const view = def.wire.view(s)
  assert.equal(view.spent.models.length, 2, `❌ 应有两条模型明细：${JSON.stringify(view.spent.models)}`)
  const ds = view.spent.models.find(m => m.model === 'deepseek-flash')
  const haiku = view.spent.models.find(m => m.model.includes('claude-haiku-5-5'))
  assert.ok(ds && ds.priced, '❌ DeepSeek 那条应计了价')
  assert.ok(Math.abs((ds?.costUsd ?? 0) - 4.353723) < 1e-5, `❌ DeepSeek 明细金额应为 $4.3537：${ds?.costUsd}`)
  assert.equal(ds?.tokens, 665_090_129, '❌ DeepSeek 明细的 token 应等于三桶之和')
  assert.ok(haiku && haiku.priced === false, '❌ 未计价模型应标 priced=false')
  assert.equal(haiku?.costUsd, 0, '❌ 未计价模型的费用必须为 0')
  assert.equal(haiku?.tokens, 1_000_000, '❌ 未计价模型的 token 也要显示')
  assert.doesNotThrow(() => def.wire.viewSchema.parse(view), '❌ 带明细的视图应通过 viewSchema')
}

// ── 6f. ★ 配置的模型单价：DeepSeek 之外的模型也能计价（单价来自账单反解，见 scripts/calibrate-prices.py）──
{
  const prices: ConfiguredPrice[] = [{
    model: 'gpt-6.1-sol', currency: 'USD',
    inputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2, outputPerMillion: 10,
  }]
  const def = createGoalBudgetProjection({ currency: () => 'USD', prices })
  const s = fold(def, [
    { type: 'request/header', data: { header: { config: { provider: 'magpie-responses', model: 'cm-ais/gpt-6.1-sol' } } } },
    { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 100_000 } } },
  ])
  const view = def.wire.view(s)
  // 1e6×2 + 1e6×0.1 + 0.1e6×10 = 2 + 0.1 + 1 = 3.1
  assert.ok(Math.abs(view.spent.costUsd - 3.1) < 1e-9, `❌ 配置单价的模型应算出 $3.1，得到 ${view.spent.costUsd}`)
  const line = view.spent.models.find(m => m.model === 'gpt-6.1-sol')
  assert.ok(line?.priced, '❌ 应列为已计价')
  assert.equal(line?.estimated, false, '❌ 未标 estimated 的应为精确值')
  assert.doesNotThrow(() => def.wire.viewSchema.parse(view), '❌ 带明细的视图应通过 viewSchema')
}

// ── 6g. ★ 估算标记：供应商按请求变价时，金额必须标为估算 ──
{
  const prices: ConfiguredPrice[] = [{
    model: 'claude-haiku-5-5', currency: 'USD',
    inputPerMillion: 0.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625, outputPerMillion: 2.5,
    estimated: true,
  }]
  const def = createGoalBudgetProjection({ currency: () => 'USD', prices })
  const s = fold(def, [
    { type: 'request/header', data: { header: { config: { provider: 'magpie-anthropic', model: 'cm-ais/claude-haiku-5-5' } } } },
    { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage: { inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 } } },
  ])
  const line = def.wire.view(s).spent.models.find(m => m.model === 'claude-haiku-5-5')
  assert.equal(line?.estimated, true, '❌ 估算单价应标 estimated=true（面板用 ≈ 显示）')
}

// ── 6h. 币种不符：配置只有美元价，人民币账户应标未计价，而不是拿美元价顶 ──
{
  const prices: ConfiguredPrice[] = [{
    model: 'gpt-6.1-sol', currency: 'USD',
    inputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 2, outputPerMillion: 10,
  }]
  const def = createGoalBudgetProjection({ currency: () => 'CNY', prices })
  const s = fold(def, [
    { type: 'request/header', data: { header: { config: { provider: 'magpie-responses', model: 'cm-ais/gpt-6.1-sol' } } } },
    { type: 'assistant/message', time: bjTime(12), data: { turn: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
  ])
  const view = def.wire.view(s)
  assert.equal(view.spent.costUsd, 0, '❌ 币种不符时不得拿别的币种的单价计算')
  const line = view.spent.models.find(m => m.model === 'gpt-6.1-sol')
  assert.equal(line?.priced, false, '❌ 币种不符的模型应标为未计价')
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
  // 基数：状态形状每变一次就递增（7_000_000 → unpriced 带 token 数、视图加分模型明细；
  //       7_000_001 → 新增 children 计数：旧缓存里该字段是 0，而「派生过几个子代理」
  //       只能靠重新 fold 日志得到，不提升版本号历史会话会永远显示 0）。
  assert.equal(def.stateVersion, 7_000_001 + digestOf(OFF_DAYS.join(',')), '❌ 版本号应绑定日历内容')
}

console.log('✅ projection-view.spec.ts 全部通过（9 组断言）')
