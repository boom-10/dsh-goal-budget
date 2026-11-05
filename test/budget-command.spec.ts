/**
 * `/budget` 命令的端到端测试 —— 驱动真实 handler，不需要 API key（可进 CI）。
 *
 * 断言的是**行为**，不是「没抛错」：
 * 设置之后预算真的变了、清除之后真的回到默认。
 * （教训来自 ACP 事故：178 个测试全绿但功能完全不可用。）
 */

import assert from 'node:assert/strict'

const mod = await import('../src/index.ts')

/** 收集注册的命令。 */
const commands: Record<string, (inv: unknown) => { kind: string; text?: string }> = {}
const blocked: Array<{ ref: unknown; reason: { code: string; message: string } }> = []
type AnyHandler = (...a: unknown[]) => void
const handlers = new Map<string, AnyHandler[]>()
const warns: string[] = []

const registeredProjections: Array<{ key: string }> = []
const ctx = {
  // 投影注册在真实宿主里是异步的；这里同步返回一个假 handle，够验证注册发生过。
  sessionProjections: {
    register(definition: { key: string }) {
      registeredProjections.push(definition)
      return Promise.resolve({ stateOf: () => null })
    },
  },
  commands: {
    register(def: { name: string; handler: (inv: unknown) => never }) {
      commands[def.name] = def.handler as never
      return () => {}
    },
  },
  on(e: string, fn: AnyHandler) {
    if (!handlers.has(e)) handlers.set(e, [])
    handlers.get(e)!.push(fn)
  },
  logger: { warn: (s: string) => warns.push(s), info: () => {} },
  get: () => undefined,
  goals: {
    get: () => ({ id: 'goal-A', revision: 3 }),
    block: (_a: unknown, ref: unknown, reason: { code: string; message: string }) => {
      blocked.push({ ref, reason })
      return {}
    },
  },
}

// mock ctx 形状故意宽松 —— 这里只关心插件行为，不关心宿主类型。
mod.apply(ctx as never, {
  // profile 默认：1 美元
  budget: { tokens: 0, costUsd: 1, wallClockMs: 0 },
  currency: 'USD',
  deepseekCredentialRef: 'DEEPSEEK_API_KEY',
  modelAliases: {},
  peakPricing: true,
  modelPrices: [],
  onExceed: 'block',
  warnAtRatio: 0.8,
})

const fire = (e: string, ...a: unknown[]) => { for (const fn of handlers.get(e) ?? []) fn(...a) }
// 同一个会话对象贯穿全部事件（宿主里它是稳定的）。
const session = {}
// agent 是会话的作用域，真实 Agent 上有 session 字段（归因按会话隔离）。
const agent = { session }
// 北京时间 2026-11-03 12:00（周二，空闲时段）：宿主按事件时间定峰谷，测试取空闲价以保持金额期望不变。
const OFF_PEAK = Date.UTC(2026, 10, 3, 4)
// 会话的请求头：计价按它查模型的单价。没有它，用量会被当成未定价、费用为 0。
fire('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } } })

// ── 1. 命令注册了 ──
assert.ok(commands['budget'], '❌ /budget 没有注册')

// ── 2. 空输入显示 profile 默认 ──
const shown = commands['budget']!({ agent, rawInput: '' })
assert.equal(shown.kind, 'success')
assert.ok(shown.text!.includes('$1'), `❌ 应显示 profile 默认 $1，实际: ${shown.text}`)
assert.ok(shown.text!.includes('profile 默认'), '❌ 应标明来源是 profile')

// ── 3. 设会话覆盖 ──
const set = commands['budget']!({ agent, rawInput: '$0.01' })
assert.equal(set.kind, 'success')
assert.ok(set.text!.includes('$0.01'), `❌ 应确认设为 $0.01，实际: ${set.text}`)

// ── 4. ★ 覆盖真的生效了：现在 $0.01 就该被突破 ──
fire('agent/inbox/claimed', { agent, turn: 1, message: { source: { kind: 'goal', goalId: 'goal-A', round: 1 } } })
fire('session/event', session, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: { inputTokens: 100000, outputTokens: 5000 } } })

assert.equal(blocked.length, 1, `❌ 会话覆盖没生效（期望 1 次阻断，实际 ${blocked.length}）`)
assert.equal(blocked[0]!.reason.code, 'budget-exceeded')

// ── 5. 去重：同一 goal 再超也只阻断一次 ──
fire('session/event', session, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: { inputTokens: 500000, outputTokens: 9000 } } })
assert.equal(blocked.length, 1, '❌ 重复阻断了')

// ── 6. 显示用量 ──
const shown2 = commands['budget']!({ agent, rawInput: '' })
assert.ok(shown2.text!.includes('已用'), '❌ 应显示已用量')
assert.ok(shown2.text!.includes('本会话设置'), '❌ 来源应标为本会话设置')

// ── 7. 清除覆盖 → 回到 profile 默认 ──
const cleared = commands['budget']!({ agent, rawInput: 'off' })
assert.equal(cleared.kind, 'success')
assert.ok(cleared.text!.includes('$1'), `❌ 应回到 profile 默认 $1，实际: ${cleared.text}`)

// ── 8. ★ 清除之后不再按 $0.01 阻断（不会误杀）──
blocked.length = 0
fire('agent/inbox/claimed', { agent, turn: 2, message: { source: { kind: 'goal', goalId: 'goal-A', round: 2 } } })
fire('session/event', session, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 2, usage: { inputTokens: 100000, outputTokens: 5000 } } })
assert.equal(blocked.length, 0, `❌ 清除覆盖后仍在按旧预算阻断（误杀）`)

// ── 9. 非法输入报错而不是崩 ──
const bad = commands['budget']!({ agent, rawInput: 'abc' })
assert.equal(bad.kind, 'error')
assert.ok(bad.text!.length > 0)

// ── 10. ★ token 后缀 k / m 必须真的乘上去 ──
// 变异测试发现：原来只测过 `$0.01`，把 k 的乘数改成 1 一条都不红。
{
  const { parseBudgetCommand } = await import('../src/budget-command.ts')

  const k = parseBudgetCommand('500k')
  assert.equal(k.kind, 'set')
  if (k.kind === 'set') assert.equal(k.budget.tokens, 500_000, '❌ 500k 应为 500000')

  const m = parseBudgetCommand('1.5m')
  assert.equal(m.kind, 'set')
  if (m.kind === 'set') assert.equal(m.budget.tokens, 1_500_000, '❌ 1.5m 应为 1500000')

  const plain = parseBudgetCommand('500000')
  assert.equal(plain.kind, 'set')
  if (plain.kind === 'set') assert.equal(plain.budget.tokens, 500_000, '❌ 裸数字不应被乘')

  // 后缀大小写不敏感
  const upper = parseBudgetCommand('2K')
  assert.equal(upper.kind, 'set')
  if (upper.kind === 'set') assert.equal(upper.budget.tokens, 2_000, '❌ 2K 应为 2000')
}

// ── 11. 投影真的注册了（客户端靠它读预算）──
assert.equal(registeredProjections.length, 1, '❌ goalBudget 投影没注册')
assert.equal(registeredProjections[0]!.key, 'goalBudget', '❌ 投影 key 不对')

console.log('✅ budget-command.spec.ts 全部通过（11 项）')
console.log('   - profile 默认 + 会话覆盖 两级解析')
console.log('   - 覆盖真的改变阻断阈值')
console.log('   - 清除后不再误杀')
console.log('   - 同 goal 不重复阻断')
console.log('   - 非法输入报错不崩')
console.log('   - token 后缀 k/m 真的乘上去了')
console.log('   - goalBudget 投影已注册')
