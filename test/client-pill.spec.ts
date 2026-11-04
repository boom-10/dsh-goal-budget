/**
 * 浏览器半边的 pill 必须按宿主 `tokenUsage` 投影的真实形状读数据。
 *
 * 事故（0.4.0 / 0.4.1）：pill 读 `usage.totals`，但宿主 tokenUsage 的 wire 视图
 * 就是 totals 本身（扁平：uncachedInputTokens / outputTokens / cacheReadTokens /
 * cacheWriteTokens）。`usage.totals` 恒为 undefined，pill 永远 return null，
 * 功能上等于没有界面。
 *
 * 这里在 Node 里执行 client/client.js，用一个最小的 React.createElement 桩去收
 * 渲染结果，断言 pill 真的输出了花费与进度。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

let factory: ((require: (name: string) => unknown) => unknown) | undefined
;(globalThis as any).window = {
  __ModuleLoader__: {
    load(mod: { id: string; factory: typeof factory }) {
      factory = mod.factory
    },
  },
}
new Function(src)()
assert.ok(factory, '❌ client.js 没有调用 __ModuleLoader__.load')

// 最小 React 桩：createElement 返回一个可检查的节点树
type Node = { type: unknown; props: Record<string, any>; children: unknown[] }
const React = {
  createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Node {
    return { type, props: props ?? {}, children: children.flat() }
  },
}
const plugin = factory!((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}) as { inject?: unknown; apply?: (ctx: any) => void }

// 取到 GoalBudgetPill：apply 时它被注册进 slot
let Pill: ((props: any) => Node | null) | undefined
plugin.apply!({
  slots: {
    inject(_key: string, fn: () => unknown) {
      fn()
    },
    register(_meta: unknown, component: (props: any) => Node | null) {
      Pill = component
      return () => {}
    },
  },
})
assert.ok(Pill, '❌ 没有把 pill 注册进 conversation.composer.dock')

// 宿主 tokenUsage 的真实 wire 形状（扁平 totals）
const hostUsage = { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50000, cacheWriteTokens: 0 }
const useProjection = (key: string) => {
  if (key === 'tokenUsage') return hostUsage
  if (key === 'goalBudget') return { tokens: 100000, costUsd: 5 }
  return undefined
}

const out = Pill!({ useProjection })
assert.ok(out, '❌ 宿主形状的 tokenUsage 下 pill 不渲染（读错了层级）')
const text = JSON.stringify(out)
assert.match(text, /goal-budget|spend/, '❌ 渲染结果缺少 pill 标记')
assert.match(text, /\$0\.0/, '❌ 缺少花费数字')
// 两维都设时只显示占比更高的那一维（与 dims.reduce 语义一致）；这里 token 维 100k
// 占 51% 高于 $5 维的占比，所以上限文字是 "100k"，进度 51%。
assert.match(text, /\/ 100k/, '❌ 有预算时没显示上限 / 100k')
assert.match(text, /51% used/, '❌ 没有显示进度百分比')

// 全零用量不占位（与宿主 UsagePill 一致）
const zero = Pill!({ useProjection: (k: string) => (k === 'tokenUsage' ? { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : undefined) })
assert.equal(zero, null, '❌ 全零用量应不占位')

// 没有 tokenUsage 投影时不崩、不渲染
assert.equal(Pill!({ useProjection: () => undefined }), null, '❌ 缺 tokenUsage 应返回 null')

console.log('✅ client-pill.spec.ts 全部通过（3 组断言）')
