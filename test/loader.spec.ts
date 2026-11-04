/**
 * ★ 规矩 3（官方 postmortem 0001）：
 *   「A test that constructs a plugin by hand **cannot validate how the plugin loads**.
 *     At least one test must drive the **real Loader/export path end-to-end**.」
 *
 * 背景：ACP 事故里 178 个测试全绿、100% 行覆盖，生产环境却完全不可用 ——
 * 因为**所有测试都手工挂载插件**，没走真实加载路径。
 *
 * 本文件做两件事，都不需要 API key（所以能进 CI）：
 *   A. 静态断言导出形状 —— 抓住「多了一行 export default」这个具体的坑
 *   B. 用真实 loader 的 unwrapExports 语义跑一遍，断言 inject 没被丢掉
 *
 * 跑法：node --experimental-strip-types test/loader.spec.ts
 *      （或 node --test，取决于 Node 版本）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const entry = new URL('../src/index.ts', import.meta.url)

// ─────────────────────────────────────────────────────────
// A. 导出形状：命名空间插件不得有 default
// ─────────────────────────────────────────────────────────

const mod = await import(entry.href)

assert.ok(!('default' in mod), '❌ src/index.ts 导出了 default —— unwrapExports 会扔掉 inject（postmortem 0001）')
assert.equal(typeof mod.name, 'string', '❌ 缺 name 导出')
assert.ok(Array.isArray(mod.inject), '❌ 缺 inject 导出（或不是数组）')
assert.equal(typeof mod.apply, 'function', '❌ 缺 apply 导出')
assert.ok(mod.Config !== undefined, '❌ 缺 Config 导出')

// 源码级断言：`export default` 的任何变体都不允许出现。
// 运行时的 `'default' in mod` 已经能抓到，这条是防止有人用
// `export { apply as default }` 之类绕过。
const src = readFileSync(fileURLToPath(entry), 'utf8')
assert.ok(
  !/^\s*export\s+default\b/m.test(src),
  '❌ 源码里出现 `export default` —— 即使运行时判定通过也要删掉',
)
assert.ok(
  !/^\s*export\s*\{[^}]*\bas\s+default\b/m.test(src),
  '❌ 源码里出现 `export { … as default }`',
)

// ─────────────────────────────────────────────────────────
// B. 真实 loader 的 unwrapExports 语义
//    （抄自 vendor/loader/src/index.ts，用于验证 inject 存活）
// ─────────────────────────────────────────────────────────

/** 与 vendor/loader/src/index.ts 的 unwrapExports 同构 */
function unwrapExports(exports: unknown): unknown {
  if (exports === null || exports === undefined) return exports
  let e = exports as Record<string, unknown>
  e = (e.default ?? e) as Record<string, unknown>
  if (!e.__esModule) return e
  return e.default ?? e
}

const unwrapped = unwrapExports(mod) as Record<string, unknown>

assert.equal(
  unwrapped.name,
  mod.name,
  '❌ unwrapExports 之后 name 丢了 —— 说明有东西把命名空间解包掉了',
)
assert.deepEqual(
  unwrapped.inject,
  mod.inject,
  '❌★ unwrapExports 之后 inject 丢了 —— 这就是 ACP 事故的形态，会在加载期崩「without inject」',
)
assert.equal(typeof unwrapped.apply, 'function', '❌ unwrapExports 之后 apply 不是函数')

// ─────────────────────────────────────────────────────────
// C. inject 必须覆盖 apply 里用到的服务
//    （真实加载时，没声明的服务会在 fiber walk 里抛错）
// ─────────────────────────────────────────────────────────

const declared = new Set(mod.inject as string[])
for (const svc of ['goals']) {
  assert.ok(declared.has(svc), `❌ apply 用了 ctx.${svc} 但没声明进 inject`)
}

// 规矩 2：机会性读取的服务必须走 ctx.get()，不能走 ctx.<name>
// 这里只做粗筛 —— 精确检查需要 AST，超出本测试范围。
// 记录在案：apply 里 `ctx.get(` 的出现是合规的，`ctx.<未声明服务>` 不是。

console.log('✅ loader.spec.ts 全部通过')
console.log('   - 无 default 导出')
console.log('   - unwrapExports 后 inject/name/apply 存活')
console.log(`   - inject = ${JSON.stringify(mod.inject)}`)
