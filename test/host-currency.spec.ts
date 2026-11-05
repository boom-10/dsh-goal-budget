/**
 * 宿主级的币种检查：走真实的 apply 与 /budget 命令处理器（不经过纯函数）。
 */
import assert from 'node:assert/strict'
import * as mod from '../src/index.ts'

type Handler = (invocation: { agent: object; rawInput: string }) => { kind: string; text?: string }
const handlers = new Map<string, Handler>()
const ctx = {
  commands: {
    register: (def: { name: string; handler: Handler }) => {
      handlers.set(def.name, def.handler)
      return () => {}
    },
  },
  sessionProjections: { register: async () => ({}) },
  on: () => {},
  logger: { warn: () => {}, info: () => {} },
  get: () => undefined,
  goals: { get: () => undefined, block: () => undefined },
}

const config = {
  budget: { tokens: 0, costUsd: 0, wallClockMs: 0 },
  currency: 'USD' as const,
  deepseekCredentialRef: 'DEEPSEEK_API_KEY',
  modelAliases: {},
  peakPricing: true,
  modelPrices: [],
  onExceed: 'block' as const,
  warnAtRatio: 0.8,
}
mod.apply(ctx as never, config)
const budget = handlers.get('budget')
assert.ok(budget, '❌ /budget 应已注册')

// ── 1. 美元账户：设置人民币费用上限被拒绝，并说明应使用的符号 ──
{
  const result = budget({ agent: {}, rawInput: '¥30' })
  assert.equal(result.kind, 'error', '❌ 币种不符的费用上限应被拒绝')
  assert.match(result.text ?? '', /账户币种是 USD/, '❌ 应说明账户币种')
}

// ── 2. 美元账户：美元上限照常接受 ──
{
  const result = budget({ agent: {}, rawInput: '$5' })
  assert.equal(result.kind, 'success', '❌ 币种相符的上限应被接受')
}

// ── 3. token 上限不涉及币种，任何账户都接受 ──
{
  const result = budget({ agent: {}, rawInput: '500k' })
  assert.equal(result.kind, 'success', '❌ token 上限不应受币种影响')
}

console.log('✅ host-currency.spec.ts 全部通过（3 组断言）')
