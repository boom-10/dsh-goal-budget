/**
 * 浏览器半边：pill 显示的内容必须**原样来自宿主投影**。
 *
 * ## 两次事故
 *
 * 1. **读错层级**（0.4.0/0.4.1）：pill 读 `usage.totals`，但 `tokenUsage` 的 wire
 *    视图就是 totals 本身（扁平）。`usage.totals` 恒为 `undefined` → pill 永远
 *    `return null` → 功能上等于没有界面。
 *
 * 2. **客户端自己算钱**（0.4.x）：正确口径是**逐条** `max(0, input − cacheRead)`
 *    累加，而投影只给合计。cacheRead 远大于 input 的会话上合计相减归零，
 *    与宿主差 15%+。
 *
 * 现在 `goalBudget` 投影把宿主用同一个 `costOf` 算好的数送过来，
 * 这个 spec 断言「客户端只显示、不重新推导」。
 *
 * 在 Node 里执行 client/client.js，用最小 React 桩收集渲染结果。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

// ── 最小桩：接住 __ModuleLoader__.load 并提供一个假 React ──
let factory: ((require: (m: string) => unknown) => unknown) | undefined
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
  type, props: { ...(props ?? {}), children: children.filter(c => c !== null && c !== undefined) },
})
const React = { createElement: h, memo: (c: unknown) => c }

const g = globalThis as unknown as Record<string, unknown>
g['window'] = {
  __ModuleLoader__: {
    load(spec: { factory: typeof factory }) { factory = spec.factory },
  },
}
new Function('window', src)(g['window'])
assert.ok(factory, '❌ client.js 没有调用 __ModuleLoader__.load')

const mod = (factory as NonNullable<typeof factory>)((m: string) => (m === 'react' ? React : undefined)) as {
  apply(ctx: { slots: { inject(n: string, cb: () => void): void; register(d: { id: string }, c: unknown): void } }): void
}

/** 取出注册进 slot 的组件。 */
const registry: Array<{ id: string; component: unknown }> = []
mod.apply({
  slots: {
    inject(_n, cb) { cb() },
    register(def, component) { registry.push({ id: def.id, component }) },
  },
})
const entry = registry.find(r => r.id === 'goal-budget')
assert.ok(entry, '❌ 没有把 pill 注册进 conversation.composer.dock')
const P = entry.component as (props: Record<string, unknown>) => unknown

/** 递归找出所有文本与元素。 */
type El = { props?: Record<string, unknown> }
function textOf(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const n = node as El
  if (n.props === undefined) return ''
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

// ── 1. 显示宿主给的数（不去自己算）──
// 宿主口径：这条真实会话（input 4.87M / output 1.23M / cacheRead 400M）算出来是 $2.2552。
// 客户端拿到什么就显示什么，所以这里直接喂宿主的数。
const hosted = {
  budget: null,
  spent: { tokens: 2_126_484, costUsd: 2.2552, unbilledTurns: 0 },
}
const out = P({ useProjection: (k: string) => (k === 'goalBudget' ? hosted : undefined) })
assert.ok(out, '❌ 有 spent 时 pill 应渲染')
const text = textOf(out)
assert.match(text, /\$2\.26/, `❌ 应显示宿主给的 $2.26（2.2552 四舍五入到 2 位），实际：${text}`)
// 旧实现会渲染 $2.67（按 input 全额计）或 $1.94（合计相减）—— 都不该出现
assert.doesNotMatch(text, /\$2\.67/, '❌ 又按缓存重复计费了')
assert.doesNotMatch(text, /\$1\.94/, '❌ 又在客户端用合计相减自己算了')

// ── 2. 全零 / 缺失时不占位 ──
const zero = P({ useProjection: () => ({ budget: null, spent: { tokens: 0, costUsd: 0, unbilledTurns: 0 } }) })
assert.equal(zero, null, '❌ 全零用量应不占位')
assert.equal(P({ useProjection: () => undefined }), null, '❌ 缺 goalBudget 应返回 null')
assert.equal(P({}), null, '❌ 没有 useProjection 应返回 null（不能让客户端崩）')

// ── 3. 有预算时显示上限与进度 ──
const capped = P({
  useProjection: (k: string) =>
    k === 'goalBudget' ? { budget: { tokens: 0, costUsd: 5 }, spent: { tokens: 100, costUsd: 2.5, unbilledTurns: 0 } } : undefined,
})
const cappedText = textOf(capped)
assert.match(cappedText, /\/ \$5/, `❌ 应显示上限 / $5，实际：${cappedText}`)
assert.match(cappedText, /50% used/, `❌ 应显示 50%，实际：${cappedText}`)

// ── 4. 进度条：底槽不能用外层 opacity（会被填充层继承相乘）──
const trackEl = findEl(capped, n => n.props?.['style'] !== undefined
  && (n.props['style'] as Record<string, unknown>)['position'] === 'relative'
  && (n.props['style'] as Record<string, unknown>)['overflow'] === 'hidden')
assert.ok(trackEl, '❌ 找不到进度条底槽')
assert.equal((trackEl!.props!['style'] as Record<string, unknown>)['opacity'], undefined,
  '❌ 底槽不应再用外层 opacity（会传给填充层，进度条几乎不可见）')

// ── 5. 未报 usage 的 turn 要在 tooltip 里说明 ──
const partial = P({
  useProjection: (k: string) => (k === 'goalBudget' ? { budget: null, spent: { tokens: 10, costUsd: 0.5, unbilledTurns: 3 } } : undefined),
})
assert.match(textOf(partial), /3 turn\(s\) reported no usage/, '❌ 应说明有多少 turn 无法归因')

console.log('✅ client-pill.spec.ts 全部通过（5 组断言）')
console.log('   - 显示宿主给的数，不自己重算')
console.log('   - 全零 / 缺失 / 无 useProjection 都不渲染且不崩')
console.log('   - 有预算时显示上限与百分比')
console.log('   - 进度条底槽不用外层 opacity')
console.log('   - 无法归因的 turn 会在 tooltip 说明')
