/**
 * goalBudget 投影的 wire 视图必须能通过它自己的 viewSchema。
 *
 * 事故（0.4.0）：没设过 /budget 时状态是 null，view 原样返回 null，但 viewSchema 是
 * 非空对象 → DSH 读历史时 `viewSchema.parse(null)` 抛错，整个会话投影失败，
 * 每个没设预算的会话都打不开。
 *
 * 这里直接走 DSH 注册表的真实路径：init() → view() → viewSchema.parse()。
 * 任何一步抛错都说明这个投影会让读取失败。
 */

import assert from 'node:assert/strict'

const { goalBudgetProjectionDefinition: def } = await import('../src/budget-projection.ts')

const { wire } = def
assert.ok(wire, '❌ 投影缺 wire 视图')

// 1. 冷启动（没有 /budget）：DSH 会在每个会话上这样 fold 出初始值
const initial = def.init()
const viewed = wire.view(initial)
assert.doesNotThrow(
  () => wire.viewSchema.parse(viewed),
  `❌ 没设过预算时 viewSchema 拒绝 view 的结果（${JSON.stringify(viewed)}）——所有没设预算的会话都会历史加载失败`,
)
assert.equal(viewed, null, '❌ 没设预算时视图应为 null（客户端靠它判断「未设置」）')

// 2. 设置过预算：视图是合法对象，同样必须通过
const set = { tokens: 500_000, costUsd: 5 }
assert.doesNotThrow(() => wire.viewSchema.parse(wire.view(set)), '❌ 设置预算后的视图没通过 viewSchema')

// 3. 非法值仍被拒绝（说明 schema 没有被放成「什么都收」）
assert.throws(() => wire.viewSchema.parse({ tokens: -1, costUsd: 1 }), '❌ 负数 token 应被拒绝')
assert.throws(() => wire.viewSchema.parse({ tokens: 1, costUsd: 1, extra: 1 }), '❌ 多余字段应被拒绝（strict）')
assert.throws(() => wire.viewSchema.parse('not-an-object'), '❌ 非对象应被拒绝')

console.log('✅ projection-view.spec.ts 全部通过（3 组断言）')
console.log('   - 未设预算的 null 视图通过 viewSchema')
console.log('   - 设置后的视图通过 viewSchema')
console.log('   - 非法形状仍被拒绝')
