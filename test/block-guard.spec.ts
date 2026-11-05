/**
 * goal 不在 active 时，超预算不能硬调 ctx.goals.block()；block 抛错时，也不能冒泡到事件回调里。
 *
 * 背景：block() 只接受 active 的 goal。用户可能刚暂停或完成了 goal。之前的代码这时会抛错，
 * 抛在事件回调里，而且 blocked 也没有被记下。
 */
import assert from 'node:assert/strict'
import * as mod from '../src/index.ts'

type Listener = (...args: never[]) => void

const OFF_PEAK = Date.UTC(2026, 10, 3, 4) // 北京时间 2026-11-03 12:00（空闲时段）
// 1,000,000 未命中输入 × $0.15/M = $0.15，超过 $0.10 的预算
const USAGE = { inputTokens: 1_000_000, outputTokens: 0 }
const ROUTE = { provider: 'ais', model: 'ais/llm-gateway--deepseek-v4-flash' }

const listeners = new Map<string, Listener>()
const warns: string[] = []
const blockCalls: Array<{ code?: string }> = []
let goalPhase: 'active' | 'paused' = 'active'
let blockThrows = false

mod.apply({
  commands: { register: () => () => {} },
  sessionProjections: { register: async () => ({ dispose: () => {}, stateOf: () => ({ route: null }) }) },
  on: (event: string, listener: Listener) => { listeners.set(event, listener) },
  logger: { warn: (s: string) => warns.push(s), info: () => {} },
  get: () => undefined,
  goals: {
    get: () => ({ id: 'goal-X', revision: 1, phase: goalPhase }),
    block: (_a: unknown, _r: unknown, reason: { code?: string }) => {
      if (blockThrows) throw new Error('GOAL_REVISION_MISMATCH: expected revision 1, current 2')
      blockCalls.push(reason)
    },
  },
} as never, {
  budget: { tokens: 0, costUsd: 0.1, wallClockMs: 0 },
  currency: 'USD',
  deepseekCredentialRef: 'DEEPSEEK_API_KEY',
  modelAliases: {},
  peakPricing: true,
  modelPrices: [],
  onExceed: 'block',
  warnAtRatio: 0.8,
} as never)

const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...(args as never[]))
await new Promise((resolve) => setTimeout(resolve, 0))

/** 让某个 goal 的用量超过预算，触发阻断路径 */
function overBudget(goalId: string): void {
  const session = {}
  const agent = { session }
  emit('agent/inbox/claimed', { agent, turn: 1, message: { source: { kind: 'goal', goalId, round: 1 } } })
  emit('session/event', session, { type: 'request/header', data: { header: { config: ROUTE } } })
  emit('session/event', session, { type: 'assistant/message', time: OFF_PEAK, data: { turn: 1, usage: USAGE } })
}

// ── 1. goal 已暂停：不调 block，不抛错，并说明原因 ──
goalPhase = 'paused'
blockThrows = false
overBudget('goal-P')
assert.equal(blockCalls.length, 0, `❌ goal 不在 active 时不应调用 block，实际调用了 ${blockCalls.length} 次`)
assert.ok(warns.some((w) => w.includes('goal-P 当前是 paused')), `❌ 应说明为什么没有阻断：${warns.join(' | ')}`)

// ── 2. block 抛错（比如 revision 已变）：不冒泡，记一条警告 ──
goalPhase = 'active'
blockThrows = true
assert.doesNotThrow(() => overBudget('goal-T'), '❌ block 抛错不应冒泡到事件回调里')
assert.ok(
  warns.some((w) => w.includes('阻断 goal goal-T 失败') && w.includes('GOAL_REVISION_MISMATCH')),
  `❌ 应记下阻断失败的原因：${warns.join(' | ')}`,
)

// ── 3. 对照组：active 且 block 正常 → 阻断一次 ──
blockThrows = false
overBudget('goal-OK')
assert.equal(blockCalls.length, 1, `❌ active 的 goal 超预算应阻断一次，实际 ${blockCalls.length} 次`)
assert.equal(blockCalls[0]?.code, 'budget-exceeded')

console.log('✅ block-guard.spec.ts 全部通过（3 组断言）')
