/**
 * 宿主级：**只用 `/budget` 设置预算**的会话必须真的记账并阻断。
 *
 * 背景（OBSERVED，0.9.1 修）：`apply` 里原本有一句 `if (unlimited) return`，位于事件监听器
 * 注册之前。于是 profile 没设默认预算时：`/budget $5` 会成功、pill 也会显示数字（投影在
 * return 之前注册），但用量完全没记账，预警与阻断永不触发 —— 闸门静默失效。
 *
 * 本文件走真实的 apply 与事件链，断言「无 profile 默认预算 + 仅 /budget」这条路径能阻断。
 */
import assert from 'node:assert/strict'
import * as mod from '../src/index.ts'

type Handler = (invocation: { agent: object; rawInput: string }) => { kind: string; text?: string }
type Listener = (...args: never[]) => void
const OFF_PEAK = Date.UTC(2026, 10, 3, 4) // 北京时间 2026-11-03 12:00（周二 · 空闲时段）

// 1,000,000 未命中输入 × $0.15/M = $0.15
const USAGE = { inputTokens: 1_000_000, outputTokens: 0 }

const handlers = new Map<string, Handler>()
const listeners = new Map<string, Listener>()
const blocks: Array<{ code?: string; message?: string }> = []
let projectionRoute: { provider?: string; model?: string } | null = null
const session = {}
const agent = { session }

mod.apply({
  commands: { register: (def: { name: string; handler: Handler }) => { handlers.set(def.name, def.handler); return () => {} } },
  sessionProjections: { register: async () => ({ dispose: () => {}, stateOf: () => ({ route: projectionRoute }) }) },
  on: (event: string, listener: Listener) => { listeners.set(event, listener) },
  logger: { warn: () => {}, info: () => {} },
  get: () => undefined,
  goals: { get: () => ({ id: 'goal-A', revision: 1 }), block: (_a: unknown, _r: unknown, reason: { code?: string; message?: string }) => { blocks.push(reason) } },
} as never, {
  // ★ profile 没有任何默认预算 —— 这正是本文件要覆盖的场景
  budget: { tokens: 0, costUsd: 0, wallClockMs: 0 },
  currency: 'USD',
  deepseekCredentialRef: 'DEEPSEEK_API_KEY',
  modelAliases: {},
  peakPricing: true,
  onExceed: 'block',
  warnAtRatio: 0.8,
})

const budget = handlers.get('budget')
assert.ok(budget, '❌ /budget 未注册')
const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...(args as never[]))
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
await settle()

// 归因 + 路由（本进程的请求头）
emit('agent/inbox/claimed', { agent, turn: 1, message: { source: { kind: 'goal', goalId: 'goal-A', round: 1 } } })
emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'ais', model: 'ais/llm-gateway--deepseek-v4-flash' } } } })

// ── 1. 仅用 /budget 设置上限：命令成功 ──
{
  const set = budget({ agent, rawInput: '$0.10' })
  assert.equal(set.kind, 'success', `❌ /budget 应成功：${set.text}`)
}

// ── 2. 用量被真的记账（修复前这里是「无限制 + 无已用」）──
{
  emit('session/event', session, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: USAGE } })
  const shown = budget({ agent, rawInput: '' })
  assert.match(shown.text ?? '', /\$0\.150/, `❌ 应显示已用 $0.150：${shown.text}`)
}

// ── 3. 超过上限后真的阻断 ──
{
  assert.equal(blocks.length, 1, `❌ 超限应阻断一次，实际 ${blocks.length} 次`)
  assert.match(blocks[0]?.code ?? '', /budget/, `❌ 阻断原因应带预算码：${JSON.stringify(blocks[0])}`)
}

// ── 4. 同一个 goal 不重复阻断 ──
{
  emit('session/event', session, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: USAGE } })
  assert.equal(blocks.length, 1, '❌ 同一个 goal 不应重复阻断')
}

// ── 5. 路由回退：本进程没看到请求头时，从投影读（插件中途加载 / 重启后模型未变）──
//     ★ 必须用一个**全新的 session 对象**：前面那个 session 已经收到过请求头，缓存命中就
//       走不到回退分支了（这一点是变异检验发现的 —— 原来的写法让变异存活）。
{
  projectionRoute = { provider: 'ais', model: 'ais/llm-gateway--deepseek-v4-flash' }
  const freshSession = {}
  const freshAgent = { session: freshSession }
  emit('agent/inbox/claimed', { agent: freshAgent, turn: 1, message: { source: { kind: 'goal', goalId: 'goal-B', round: 1 } } })
  emit('session/event', freshSession, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: USAGE } })
  const shown = budget({ agent: freshAgent, rawInput: '' })
  assert.match(shown.text ?? '', /\$0\.150/, `❌ 应从投影读到路由并计价：${shown.text}`)
}

// ── 6. 投影里也没有路由：不猜，费用为 0 ──
{
  projectionRoute = null
  const bareSession = {}
  const bareAgent = { session: bareSession }
  emit('agent/inbox/claimed', { agent: bareAgent, turn: 1, message: { source: { kind: 'goal', goalId: 'goal-C', round: 1 } } })
  emit('session/event', bareSession, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: USAGE } })
  const shown = budget({ agent: bareAgent, rawInput: '' })
  assert.match(shown.text ?? '', /\$0(?!\.15)/, `❌ 路由未知时不得伪造费用：${shown.text}`)
}

console.log('✅ host-session-budget.spec.ts 全部通过（6 组断言）')
