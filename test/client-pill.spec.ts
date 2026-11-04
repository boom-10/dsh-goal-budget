/**
 * 浏览器半边：pill 显示的内容必须**原样来自宿主投影**，并且**可点击**展开明细。
 *
 * ## 三次事故（都在这个文件里留了断言）
 *
 * 1. **读错层级**（0.4.0/0.4.1）：pill 读 `usage.totals`，但 `tokenUsage` 的 wire
 *    视图就是 totals 本身。恒为 `undefined` → pill 永远 `return null`。
 * 2. **客户端自己算钱**（0.4.x）：正确口径是逐条 `max(0, input − cacheRead)` 累加，
 *    投影只给合计 —— cacheRead 远大于 input 的会话上会归零，差 15%+。
 * 3. **点不开**（0.5.x）：只是个静态 `<span>`，没有任何交互。
 *
 * 在 Node 里执行 client/client.js，用最小 React + 原语桩收集渲染结果。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

// ── 最小 React 桩：hooks 记录状态，便于断言「点了会变」──
type El = { type: unknown; props: Record<string, unknown> }
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
  type, props: { ...(props ?? {}), children: children.filter(c => c !== null && c !== undefined) },
})

/** 桩状态：useState 的返回值可被测试直接读到。 */
/**
 * hook 槽位桩。
 *
 * ⚠️ 必须**跨渲染保留**状态：真实 React 只在挂载时用一次初始值，
 * 而「每次调用都重置成 initial」会让「点击 → 状态翻转 → 重渲染」
 * 这条链永远看不到翻转（我第一版就栽在这）。
 */
const hooks: Array<{ value: unknown }> = []
let hookCursor = 0

function resetCursor(): void { hookCursor = 0 }

const React = {
  createElement: h,
  memo: (c: unknown) => c,
  useState(initial: unknown) {
    const i = hookCursor++
    if (hooks[i] === undefined) hooks[i] = { value: initial }
    const slot = hooks[i]!
    return [slot.value, (v: unknown) => {
      slot.value = typeof v === 'function' ? (v as (p: unknown) => unknown)(slot.value) : v
    }]
  },
  useRef(initial: unknown) {
    const i = hookCursor++
    if (hooks[i] === undefined) hooks[i] = { value: { current: initial } }
    return hooks[i]!.value
  },
}

/** 一次「渲染」：重置 hook 游标后调用组件。 */
function render(component: (p: Record<string, unknown>) => El | null, props: Record<string, unknown>): El | null {
  resetCursor()
  return component(props)
}

/**
 * 模拟全新挂载：清空 hook 槽。
 *
 * ⚠️ 不调用它的话，前一个用例点击留下的 `open: true` 会带到下一个用例，
 * 于是「点击展开」变成「点击收起」—— 我第一版就栽在这。
 */
function remount(): void {
  hooks.length = 0
  resetCursor()
}

// ── 原语桩：只记录被调用，返回可辨认的标记 ──
const primitiveCalls: string[] = []
const primitives = {
  Pill: (p: Record<string, unknown>) => { primitiveCalls.push('Pill'); return h('Pill', p, p['children'] as never) },
  StateDot: (p: Record<string, unknown>) => { primitiveCalls.push('StateDot'); return h('StateDot', p) },
  useAnchoredPosition: (o: { open: boolean }) => { primitiveCalls.push('useAnchoredPosition'); return o.open ? { left: 10, top: 20 } : null },
  useDismissOnOutsidePointer: () => { primitiveCalls.push('useDismissOnOutsidePointer') },
}

// ── 接住 __ModuleLoader__.load ──
let factory: ((require: (m: string) => unknown) => unknown) | undefined
const win = { __ModuleLoader__: { load(spec: { factory: typeof factory }) { factory = spec.factory } } }
new Function('window', src)(win)
assert.ok(factory, '❌ client.js 没有调用 __ModuleLoader__.load')

const mod = (factory as NonNullable<typeof factory>)((m: string) =>
  m === 'react' ? React : m === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined) as {
  apply(ctx: { slots: { inject(n: string, cb: () => void): void; register(d: { id: string }, c: unknown): void } }): void
}

const registry: Array<{ id: string; component: unknown }> = []
mod.apply({
  slots: {
    inject(_n, cb) { cb() },
    register(def, component) { registry.push({ id: def.id, component }) },
  },
})
const entry = registry.find(r => r.id === 'goal-budget')
assert.ok(entry, '❌ 没有把 pill 注册进 conversation.composer.dock')
const Pill = entry.component as (props: Record<string, unknown>) => El | null

/** 递归收集文本。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const n = node as El
  if (n?.props === undefined) return ''
  const kids = n.props['children']
  const list = Array.isArray(kids) ? kids : [kids]
  const title = typeof n.props['title'] === 'string' ? n.props['title'] : ''
  return title + ' ' + list.map(textOf).join(' ')
}

function findEl(node: unknown, pred: (n: El) => boolean): El | null {
  const n = node as El
  if (n?.props !== undefined) {
    if (pred(n)) return n
    const kids = n.props['children']
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      const hit = findEl(k, pred)
      if (hit) return hit
    }
  }
  return null
}

const HOSTED = {
  budget: null,
  spent: { tokens: 2_126_484, costUsd: 2.2552, unbilledTurns: 0 },
}
const view = (k: string) => (k === 'goalBudget' ? HOSTED : undefined)

// ── 1. 显示宿主给的数（不自己算）──
{
  remount()
  const out = render(Pill, { useProjection: view })
  assert.ok(out, '❌ 有 spent 时 pill 应渲染')
  const text = textOf(out)
  assert.match(text, /\$2\.26/, `❌ 应显示宿主给的 $2.26，实际：${text}`)
  assert.doesNotMatch(text, /\$2\.67/, '❌ 又按缓存重复计费了')
  assert.doesNotMatch(text, /\$1\.94/, '❌ 又在客户端用合计相减自己算了')
}

// ── 2. ★ 可点击：用宿主的 Pill 原语（有 onClick 才是真 button）──
{
  remount()
  const out = render(Pill, { useProjection: view })
  // 客户端把原语作为元素的 type 传出去，由 React 渲染时调用。
  // 所以断言「type 就是宿主那个组件」，而不是「桩函数被调用过」。
  const rootKids = (out as El).props['children']
  const pillNode = (Array.isArray(rootKids) ? rootKids[0] : rootKids) as El
  assert.equal(pillNode.type, primitives.Pill, '❌ 没有用宿主的 Pill 原语（外观/键盘可达性会和宿主不一致）')
  assert.equal(typeof pillNode.props['onClick'], 'function', '❌ 没有 onClick —— 点了不会有反应')
  assert.equal(pillNode.props['aria-haspopup'], 'dialog', '❌ 缺 aria-haspopup，屏幕阅读器不知道能展开')
  assert.equal(pillNode.props['aria-expanded'], false, '❌ 缺 aria-expanded')
  assert.ok(typeof pillNode.props['aria-label'] === 'string' && (pillNode.props['aria-label'] as string).length > 0,
    '❌ 缺 aria-label')
}

// ── 3. ★ 展开后显示明细 ──
{
  remount()
  const out = render(Pill, { useProjection: view }) as El
  const kids = out.props['children'] as El[]
  const pillEl = (Array.isArray(kids) ? kids[0] : kids) as El
  // 模拟点击
  ;(pillEl.props['onClick'] as () => void)()
  // 点击后 React 会重渲染 —— 这里显式再渲染一次
  const opened = render(Pill, { useProjection: view }) as El
  const openedKids = opened.props['children'] as unknown[]
  const panel = (Array.isArray(openedKids) ? openedKids : [openedKids])
    .find(c => (c as El)?.props?.['role'] === 'dialog')
  assert.ok(panel, '❌ 展开后没有出现 role="dialog" 的明细面板')
  const panelText = textOf(panel)
  assert.match(panelText, /Goal budget/, '❌ 面板标题缺失')
  assert.match(panelText, /Spent/, '❌ 面板应有 Spent 行')
  assert.match(panelText, /\$2\.26/, '❌ 面板应显示花费')
  assert.match(panelText, /2\.13m|2\.1m/, '❌ 面板应显示 token 数')
  assert.match(panelText, /\/budget/, '❌ 未设上限时应提示用 /budget')
}

// ── 4. 全零 / 缺失 / 无 useProjection 都不渲染且不崩 ──
{
  remount()
  assert.equal(render(Pill, { useProjection: () => ({ budget: null, spent: { tokens: 0, costUsd: 0, unbilledTurns: 0 } }) }), null,
    '❌ 全零用量应不占位')
  assert.equal(render(Pill, { useProjection: () => undefined }), null, '❌ 缺 goalBudget 应返回 null')
  assert.equal(render(Pill, {}), null, '❌ 没有 useProjection 应返回 null（不能让客户端崩）')
}

// ── 5. 有预算时显示上限与百分比；StateDot 状态跟着变 ──
{
  remount()
  const capped = (p: { budget: unknown; spent: unknown }) => render(Pill, {
    useProjection: (k: string) => (k === 'goalBudget' ? p : undefined),
  })
  const half = capped({ budget: { tokens: 0, costUsd: 5 }, spent: { tokens: 100, costUsd: 2.5, unbilledTurns: 0 } }) as El
  const halfText = textOf(half)
  assert.match(halfText, /\/ \$5/, `❌ 应显示上限，实际：${halfText}`)

  primitiveCalls.length = 0
  const over = capped({ budget: { tokens: 0, costUsd: 5 }, spent: { tokens: 100, costUsd: 6, unbilledTurns: 0 } }) as El
  const dot = findEl(over, n => n.type === primitives.StateDot)
  assert.ok(dot, '❌ 应使用宿主的 StateDot（状态色和宿主一致）')
  assert.equal(dot!.props['state'], 'error', '❌ 超预算时状态点应为 error')

  primitiveCalls.length = 0
  const near = capped({ budget: { tokens: 0, costUsd: 5 }, spent: { tokens: 100, costUsd: 4.5, unbilledTurns: 0 } }) as El
  assert.equal(findEl(near, n => n.type === primitives.StateDot)!.props['state'], 'warning', '❌ 80% 以上应为 warning')
}

// ── 6. 进度条底槽不能用外层 opacity（会被填充层继承相乘）──
{
  remount()
  const capped = render(Pill, {
    useProjection: (k: string) => (k === 'goalBudget'
      ? { budget: { tokens: 0, costUsd: 5 }, spent: { tokens: 100, costUsd: 2.5, unbilledTurns: 0 } }
      : undefined),
  })
  const track = findEl(capped, n =>
    (n.props['style'] as Record<string, unknown> | undefined)?.['overflow'] === 'hidden')
  assert.ok(track, '❌ 找不到进度条底槽')
  assert.equal((track!.props['style'] as Record<string, unknown>)['opacity'], undefined,
    '❌ 底槽不应再用外层 opacity（会传给填充层）')
}

// ── 7. 无法归因的 turn 要说明 ──
{
  remount()
  const partial = render(Pill, {
    useProjection: (k: string) => (k === 'goalBudget'
      ? { budget: null, spent: { tokens: 10, costUsd: 0.5, unbilledTurns: 3 } }
      : undefined),
  }) as El
  const kids = partial.props['children'] as El[]
  const pillEl = (Array.isArray(kids) ? kids[0] : kids) as El
  ;(pillEl.props['onClick'] as () => void)()
  const opened = render(Pill, {
    useProjection: (k: string) => (k === 'goalBudget'
      ? { budget: null, spent: { tokens: 10, costUsd: 0.5, unbilledTurns: 3 } }
      : undefined),
  }) as El
  assert.match(textOf(opened), /3 turn\(s\) reported no token usage/, '❌ 应说明有多少 turn 无法归因')
}

console.log('✅ client-pill.spec.ts 全部通过（7 组断言）')
console.log('   - 显示宿主给的数，不自己重算')
console.log('   - 用宿主的 Pill 原语，带 onClick / aria-haspopup / aria-expanded')
console.log('   - 点击后出现 role=dialog 明细面板')
console.log('   - 全零 / 缺失 / 无 useProjection 都不渲染且不崩')
console.log('   - StateDot 状态随用量变（done / warning / error）')
console.log('   - 进度条底槽不用外层 opacity')
console.log('   - 无法归因的 turn 会在面板说明')
