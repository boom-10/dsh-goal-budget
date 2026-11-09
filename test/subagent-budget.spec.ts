/**
 * 宿主级：**子代理（subagent）的用量必须计入派生它的那个目标的预算。**
 *
 * 背景（OBSERVED，0.10.3 修）：子代理跑在**自己的会话**里，它的 `assistant/message`
 * 不会出现在父会话的事件流中。而原先的事件处理按 `(会话, turn)` 查归属表，子代理的
 * turn 不在表里 → 直接 `return`，用量被丢弃。实测作者本机的 6 个子代理共 28,170,632
 * token（占父会话 4.12%），账本里为 0：金额与 token 双双漏计，闸门看不见扇出。
 *
 * 触发它的是《AI Agent 架构模式与实战》第 23 章的三级预算（Task / Session / **Agent**）
 * —— 「防止多 Agent 协作时某个 Agent 独占预算」。DSH 在派生处发的 `subagent/catalog`
 * 事件带 `childId` 与 `childCreatedAt`，归因所需的两个信息都在里面。
 *
 * ⚠️ 本文件里**最重要的一条**是「继承前缀不得重复计入」：子会话的日志包含继承自父会话
 *    的整段历史（实测某子代理 1474 条 usage 是继承的、只有 15 条是自己的）。不按
 *    `childCreatedAt` 切分，就会把父会话的历史再加一遍 —— 账目直接翻倍。
 */
import assert from 'node:assert/strict'
import * as mod from '../src/index.ts'
import { createGoalBudgetProjection } from '../src/budget-projection.ts'

type Handler = (invocation: { agent: object; rawInput: string }) => { kind: string; text?: string }
type Listener = (...args: never[]) => void

const OFF_PEAK = Date.UTC(2026, 10, 3, 4) // 北京时间 2026-11-03 12:00（周二 · 空闲时段）
const ROUTE = { provider: 'ais', model: 'ais/llm-gateway--deepseek-v4-flash' }
// deepseek-flash 空闲时段未命中输入 $0.15/M
const PARENT_USAGE = { inputTokens: 100_000, outputTokens: 0 } // $0.015
const CHILD_USAGE = { inputTokens: 400_000, outputTokens: 0 } // $0.06
const INHERITED_USAGE = { inputTokens: 10_000_000, outputTokens: 0 } // $1.50 —— 若被误计入，任何上限都会破

/** 每个用例一套干净的服务与账本（模块级状态是按 agent 隔离的，用新对象即可）。 */
async function harness() {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Listener>()
  const blocks: Array<{ code?: string; message?: string }> = []
  const parentSession = {}
  const parentAgent = { session: parentSession }
  const childSession = { id: 'child-1' }
  const strangerSession = { id: 'stranger-1' }

  mod.apply(
    {
      commands: { register: (def: { name: string; handler: Handler }) => { handlers.set(def.name, def.handler); return () => {} } },
      sessionProjections: { register: async () => ({ dispose: () => {}, stateOf: () => ({ route: ROUTE }) }) },
      on: (event: string, listener: Listener) => { listeners.set(event, listener) },
      logger: { warn: () => {}, info: () => {} },
      get: () => undefined,
      goals: {
        get: () => ({ id: 'goal-A', revision: 1, phase: 'active' }),
        block: (_a: unknown, _r: unknown, reason: { code?: string; message?: string }) => { blocks.push(reason) },
      },
    } as never,
    {
      budget: { tokens: 0, costUsd: 0, wallClockMs: 0 }, // profile 无默认预算，用 /budget 设
      currency: 'USD',
      deepseekCredentialRef: 'DEEPSEEK_API_KEY',
      modelAliases: {},
      peakPricing: true,
      modelPrices: [],
      onExceed: 'block',
      warnAtRatio: 0.8,
    },
  )

  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...(args as never[]))
  // `sessionProjections.register()` 返回 Promise：句柄落地前，路由回退读不到投影，
  // 子代理（没有自己的 request/header 时）会取不到单价。等一次微任务。
  await new Promise(resolve => setTimeout(resolve, 0))

  // 真实场景里每个会话都会发自己的 request/header —— 子代理也不例外。
  emit('session/event', childSession, { type: 'request/header', time: OFF_PEAK, data: { header: { config: ROUTE } } })

  // 父会话：归因 → 路由 → 第 1 轮用量
  emit('agent/inbox/claimed', { agent: parentAgent, turn: 1, message: { source: { kind: 'goal', goalId: 'goal-A', round: 1 } } })
  emit('session/event', parentSession, { type: 'request/header', time: OFF_PEAK, data: { header: { config: ROUTE } } })
  emit('session/event', parentSession, { type: 'turn/start', time: OFF_PEAK, data: { turn: 1 } })
  emit('session/event', parentSession, { type: 'assistant/message', time: OFF_PEAK + 1000, data: { turn: 1, usage: PARENT_USAGE } })
  // 上限 $0.05：父会话自己只花了 $0.015，尚不超
  const set = handlers.get('budget')?.({ agent: parentAgent, rawInput: '$0.05' })
  assert.equal(set?.kind, 'success', `❌ /budget 应成功：${set?.text}`)

  /** 父会话派生一个子代理。 */
  const spawn = (childId = 'child-1', createdAt = OFF_PEAK + 2000) =>
    emit('session/event', parentSession, {
      type: 'subagent/catalog', time: createdAt,
      data: { version: 0, childId, childCreatedAt: createdAt, mode: 'continuable', label: '写文档' },
    })

  return { emit, blocks, parentSession, parentAgent, childSession, strangerSession, spawn }
}

// ── 1. 子代理自己的用量计入预算：父会话没超，加上子代理就超 ──
{
  const h = await harness()
  const CREATED = OFF_PEAK + 2000
  h.spawn('child-1', CREATED)
  assert.equal(h.blocks.length, 0, '❌ 还没花子代理的钱，不该阻断')

  h.emit('session/event', h.childSession, {
    type: 'assistant/message', time: CREATED + 500, data: { turn: 7, usage: CHILD_USAGE },
  })

  assert.equal(h.blocks.length, 1, '❌ 子代理的用量未计入预算 —— 扇出会绕过闸门')
  // 金额必须是两者之和：$0.015 + $0.06 = $0.075
  assert.match(String(h.blocks[0]?.message), /0\.075000 \/ 0\.05/, `❌ 阻断金额应含子代理：${h.blocks[0]?.message}`)
  assert.equal(h.blocks[0]?.code, 'budget-exceeded')
}

// ── 2. ★ 继承前缀不得计入；同一会话里「自己的」用量仍须计入 ──
{
  const h = await harness()
  const CREATED = OFF_PEAK + 2000
  h.spawn('child-1', CREATED)

  // 子会话日志里**早于创建时刻**的用量 = 从父会话继承的历史。$1.50，若计入必然超限。
  h.emit('session/event', h.childSession, {
    type: 'assistant/message', time: CREATED - 1000, data: { turn: 3, usage: INHERITED_USAGE },
  })
  assert.equal(h.blocks.length, 0, '❌ 继承自父会话的历史被重复计入了 —— 账目会翻倍')

  // 创建之后的用量属于它自己，必须计入（否则上一条断言可能因为「整体没生效」而假通过）
  h.emit('session/event', h.childSession, {
    type: 'assistant/message', time: CREATED + 1, data: { turn: 9, usage: CHILD_USAGE },
  })
  assert.equal(h.blocks.length, 1, '❌ 子代理自身（创建之后）的用量必须计入')
  assert.match(String(h.blocks[0]?.message), /0\.075000 \/ 0\.05/, '❌ 继承前缀不该进入金额')
}

// ── 3. 未知会话的用量不得计入（不跨会话串账） ──
{
  const h = await harness()
  h.emit('session/event', h.strangerSession, {
    type: 'assistant/message', time: OFF_PEAK + 5000, data: { turn: 2, usage: INHERITED_USAGE },
  })
  assert.equal(h.blocks.length, 0, '❌ 与本目标无关的会话的用量被计入了')
}

// ── 4. 投影：只数「派生了几个子代理」，并在视图里暴露 ──
{
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
  assert.equal(def.wire.view(def.init()).spent.children, 0, '❌ 空状态应为 0 个子代理')
  assert.doesNotThrow(() => def.wire.viewSchema.parse(def.wire.view(def.init())), '❌ 空视图没通过 viewSchema')

  const one = def.apply(def.init(), { type: 'subagent/catalog', data: { childId: 'c1', childCreatedAt: 1 } })
  const two = def.apply(one, { type: 'subagent/catalog', data: { childId: 'c2', childCreatedAt: 2 } })
  assert.equal(two.children, 2, '❌ 每个 subagent/catalog 应计一个子代理')
  assert.equal(def.wire.view(two).spent.children, 2, '❌ 视图应暴露子代理数，面板才能披露')

  // 无关事件必须返回同一个引用（框架要求：引用不变才不触发下游重算）
  assert.equal(def.apply(two, { type: 'turn/start', data: { turn: 1 } }), two, '❌ 无关事件应返回同一引用')
  // 缺 childId 的目录事件不计数（不猜）
  assert.equal(def.apply(two, { type: 'subagent/catalog', data: {} }).children, 2, '❌ 无 childId 不该计数')
}

// ── 5. 旧缓存（没有 children 字段）必须仍能通过校验，且按 0 处理 ──
{
  const def = createGoalBudgetProjection({ currency: () => 'USD' })
  const legacy = { budget: null, route: null, tokens: 0, unbilledTurns: 0, unpriced: [], buckets: [] }
  const parsed = def.stateSchema.parse(legacy) as { children: number }
  assert.equal(parsed.children, 0, '❌ 旧缓存缺少 children 时应默认 0，而不是拒绝加载')
}

// ── 6. 畸形 usage（provider 少报字段）不得把账本变成 NaN ──
//
// NaN 的比较恒为 false：账本一旦被污染，`checkBudget` 永远返回「未超限」，
// 闸门**彻底**失效且看不出来（只会在面板上显示 $NaN）。
{
  const h = await harness()
  const CREATED = OFF_PEAK + 2000
  h.spawn('child-1', CREATED)

  // 缺 outputTokens —— DSH 的 TokenUsage 契约里它必填，但 provider 响应是 wire 边界，
  // 少报字段时宁可标成「不可归因」，也不能污染账本。
  h.emit('session/event', h.childSession, {
    type: 'assistant/message', time: CREATED + 1, data: { turn: 9, usage: { inputTokens: 400_000 } },
  })
  assert.equal(h.blocks.length, 0, '❌ 畸形 usage 不该被当作真实花费')

  // 账本若仍是好的，随后一条正常用量必须照常触发（$0.015 + $0.06 = $0.075 > $0.05）
  h.emit('session/event', h.childSession, {
    type: 'assistant/message', time: CREATED + 2, data: { turn: 10, usage: CHILD_USAGE },
  })
  assert.equal(h.blocks.length, 1, '❌ 账本被 NaN 污染了：闸门再也触发不了')
  assert.match(String(h.blocks[0]?.message), /0\.075000/, '❌ 金额被 NaN 污染')
}

console.log('✅ subagent-budget.spec.ts 全部通过（6 组断言）')
