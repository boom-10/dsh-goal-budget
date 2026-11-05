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

// ── document 桩：portal 的目标 ──
const BODY = { __body: true }
;(globalThis as unknown as Record<string, unknown>)['document'] = { body: BODY }

/**
 * react-dom 桩。
 *
 * `createPortal(node, target)` 在真实 React 里会把 node 挂到 target 下；
 * 这里返回 node 本身（测试就能照常遍历它），同时记录调用参数用于断言
 * 「面板确实 portal 出去了」—— 内联渲染会被 composer 的 overflow 裁掉。
 */
const portalCalls: Array<{ node: unknown; target: unknown }> = []
const ReactDOM = {
  createPortal(node: unknown, target: unknown) {
    portalCalls.push({ node, target })
    return node
  },
}

// ── 原语桩：只记录被调用，返回可辨认的标记 ──
/** 覆盖 useAnchoredPosition 的返回值；undefined 表示用默认行为。 */
let posOverride: unknown = undefined
/** 最近一次传给 useAnchoredPosition 的选项。 */
let lastAnchorOptions: { side?: string; align?: string } | undefined
const primitiveCalls: string[] = []
const primitives = {
  Pill: (p: Record<string, unknown>) => { primitiveCalls.push('Pill'); return h('Pill', p, p['children'] as never) },
  StateDot: (p: Record<string, unknown>) => { primitiveCalls.push('StateDot'); return h('StateDot', p) },
  // ⚠️ 客户端在 factory 阶段就解构了这些函数，所以事后替换 primitives.xxx 无效 ——
  //    要控制返回值只能用下面这个开关。
  useAnchoredPosition: (o: { open: boolean; side?: string; align?: string }) => {
    primitiveCalls.push('useAnchoredPosition')
    lastAnchorOptions = o
    if (posOverride !== undefined) return posOverride
    return o.open ? { left: 10, top: 20 } : null
  },
  useDismissOnOutsidePointer: () => { primitiveCalls.push('useDismissOnOutsidePointer') },
}

// ── 接住 __ModuleLoader__.load ──
let factory: ((require: (m: string) => unknown) => unknown) | undefined
const win = { __ModuleLoader__: { load(spec: { factory: typeof factory }) { factory = spec.factory } } }
new Function('window', src)(win)
assert.ok(factory, '❌ client.js 没有调用 __ModuleLoader__.load')

const mod = (factory as NonNullable<typeof factory>)((m: string) =>
  m === 'react' ? React
    : m === 'react-dom' ? ReactDOM
      : m === '@deepseek-ai/dsh-client-ui-primitives' ? primitives
        : undefined) as {
  apply(ctx: {
    effect(fn: () => void, description?: string): void
    locale: {
      register(ns: string, localeOrDicts: string | Record<string, Record<string, string>>, dict?: Record<string, string>): () => void
      bind(ns: string): (key: string, params?: Record<string, unknown>) => string
    }
    slots: {
      inject(n: string, cb: () => void): void
      register(d: { id: string }, c: unknown): void
    }
  }): void
}

/**
 * locale 服务桩 —— 照抄 LocaleRuntime 的行为：
 * 字典查找按语言回退，`{name}` 插值，未命中的 key 原样显示自己。
 */
// 默认 en：前 9 组断言写的是英文文案。第 10 组显式切到 zh 验证中文。
let activeLocale = 'en'
const dicts: Record<string, Record<string, Record<string, string>>> = {}
const localeMock = {
  register(ns: string, localeOrDicts: string | Record<string, Record<string, string>>, dict?: Record<string, string>) {
    dicts[ns] ??= {}
    if (typeof localeOrDicts === 'string') {
      dicts[ns]![localeOrDicts] = dict!
    } else {
      for (const [loc, d] of Object.entries(localeOrDicts)) dicts[ns]![loc] = d
    }
    return () => {}
  },
  bind(ns: string) {
    return (key: string, params?: Record<string, unknown>) => {
      const tpl = dicts[ns]?.[activeLocale]?.[key] ?? dicts[ns]?.['en']?.[key] ?? key
      if (params === undefined) return tpl
      return tpl.replace(/\{(\w+)\}/g, (m: string, n: string) => (n in params ? String(params[n]) : m))
    }
  },
}

const registry: Array<{ id: string; component: unknown }> = []
mod.apply({
  effect(fn: () => void) { fn() },
  locale: localeMock,
  slots: {
    inject(_n: string, cb: () => void) { cb() },
    register(def: { id: string }, component: unknown) { registry.push({ id: def.id, component }) },
  },
})
const entry = registry.find(r => r.id === 'goal-budget')
assert.ok(entry, '❌ 没有把 pill 注册进 conversation.composer.dock')
const Pill = entry.component as (props: Record<string, unknown>) => El | null

/** 点击 pill：把它的 onClick 当作函数调用（props 是 unknown，需要收窄）。 */
function clickPill(out: El | null): void {
  const kids = (out as El).props['children']
  const pill = (Array.isArray(kids) ? kids[0] : kids) as El
  const onClick = pill.props['onClick']
  assert.equal(typeof onClick, 'function', '❌ pill 没有 onClick')
  ;(onClick as () => void)()
}

/** 递归收集文本。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  // React 允许把数组当作子元素（例如 `h('div', null, items.map(...))`）。
  // 替身必须同样支持，否则嵌套数组会被静默丢掉 —— 这正是分模型明细第一次没被断出来的原因。
  if (Array.isArray(node)) return node.map(textOf).join(' ')
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
  spent: { tokens: 665_090_129, costUsd: 4.3537, unbilledTurns: 0 },
}
const view = (k: string) => (k === 'goalBudget' ? HOSTED : undefined)

// ── 1. 显示宿主给的数（不自己算）──
{
  remount()
  const out = render(Pill, { useProjection: view })
  assert.ok(out, '❌ 有 spent 时 pill 应渲染')
  const text = textOf(out)
  assert.match(text, /\$4\.35/, `❌ 应显示宿主给的 $4.35，实际：${text}`)
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
  // 模拟点击
  clickPill(out)
  // 点击后 React 会重渲染 —— 这里显式再渲染一次
  const opened = render(Pill, { useProjection: view }) as El
  const openedKids = opened.props['children'] as unknown[]
  const panel = (Array.isArray(openedKids) ? openedKids : [openedKids])
    .find(c => (c as El)?.props?.['role'] === 'dialog')
  assert.ok(panel, '❌ 展开后没有出现 role="dialog" 的明细面板')

  // ★ 必须 portal 到 document.body：内联渲染会被 composer 的 overflow 裁掉
  //   （0.6.0 的事故：面板被切在屏幕右下角）。
  //   useAnchoredPosition 的契约就是「body-portaled panels」。
  const call = portalCalls[portalCalls.length - 1]
  assert.ok(call, '❌ 面板没有走 createPortal —— 会被 composer 的 overflow 裁掉')
  assert.equal(call!.target, BODY, '❌ 面板应 portal 到 document.body')
  assert.equal(call!.node, panel, '❌ portal 的不是那个面板元素')
  const panelText = textOf(panel)
  assert.match(panelText, /Goal budget/, '❌ 面板标题缺失')
  assert.match(panelText, /Spent/, '❌ 面板应有 Spent 行')
  assert.match(panelText, /\$4\.35/, '❌ 面板应显示花费')
  assert.match(panelText, /665\.09m/, '❌ 面板应显示 token 数')
  assert.match(panelText, /\/budget/, '❌ 未设上限时应提示用 /budget')
}

// ── 3b. 首帧测量：pos 还是 null 时必须隐藏但参与布局 ──
// 钩子靠首帧量真实尺寸做夹取；若首帧不渲染，面板会被摆到视口外。
{
  remount()
  posOverride = null   // 模拟「钩子还没量到」的首帧
  const out = render(Pill, { useProjection: view }) as El
  clickPill(out)
  const opened = render(Pill, { useProjection: view }) as El
  const panel = findEl(opened, n => n.props['role'] === 'dialog')
  assert.ok(panel, '❌ 首帧也应渲染面板（供测量）')
  const style = panel!.props['style'] as Record<string, unknown>
  assert.equal(style['visibility'], 'hidden', '❌ 首帧面板应隐藏但仍参与布局')
  assert.equal(style['position'], 'fixed', '❌ 面板必须 fixed 定位（契约要求）')
  posOverride = undefined
}

// ── 3c. 面板层级要盖过模态层（宿主规定 1100）──
{
  remount()
  const first = render(Pill, { useProjection: view }) as El
  clickPill(first)
  const opened = render(Pill, { useProjection: view }) as El
  const panel = findEl(opened, n => n.props['role'] === 'dialog')
  assert.ok(panel, '❌ 找不到面板')
  assert.equal((panel!.props['style'] as Record<string, unknown>)['zIndex'], 1100,
    '❌ z-index 应为 1100（要盖在模态层 z 1000 之上）')
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
  clickPill(partial)
  const opened = render(Pill, {
    useProjection: (k: string) => (k === 'goalBudget'
      ? { budget: null, spent: { tokens: 10, costUsd: 0.5, unbilledTurns: 3 } }
      : undefined),
  }) as El
  assert.match(textOf(opened), /3 turn\(s\) reported no token usage/, '❌ 应说明有多少 turn 无法归因')
}

// ── 9b. 面板位置：pill 在输入框右侧，必须 align:'end' 向左生长 ──
// 'start' 会让面板向右铺开，看着像挂在别处而不是「点击的正上方」。
{
  remount()
  render(Pill, { useProjection: view })
  assert.equal(lastAnchorOptions?.side, 'top', '❌ 面板应在 pill 上方')
  assert.equal(lastAnchorOptions?.align, 'end',
    "❌ 应为 align:'end'（pill 右缘对齐、向左生长）；'start' 会向右铺开")
}

// ── 10. ★ 文案必须走 locale 字典，且中英都在 ──
// 官方要求：「Product-authored Client UI text must enter through these typed
// dictionaries.」硬编码英文会让中文用户看到英文。
{
  const ns = dicts['goalBudget']
  assert.ok(ns, '❌ 没有注册 goalBudget 命名空间')
  assert.ok(ns!['zh'], '❌ 缺 zh 字典 —— register 要求基线语言 zh 和 en 都在')
  assert.ok(ns!['en'], '❌ 缺 en 字典')
  assert.deepEqual(
    Object.keys(ns!['zh']!).sort(), Object.keys(ns!['en']!).sort(),
    '❌ 中英字典的键不一致（漏翻的键会回退显示 key 本身）',
  )

  /**
   * 取「打开后的面板」文本。
   *
   * ⚠️ 不能拿整棵树：pill 的 title 也走 t，即使面板里的标签被硬编码成英文，
   * 整棵树里仍有中文，断言会假过（第一版就漏网了）。
   */
  function panelText(locale: string): string {
    activeLocale = locale
    remount()
    const first = render(Pill, { useProjection: view }) as El
    clickPill(first)
    const opened = render(Pill, { useProjection: view }) as El
    const panel = findEl(opened, n => n.props['role'] === 'dialog')
    assert.ok(panel, '❌ 找不到面板')
    return textOf(panel)
  }

  const zh = panelText('zh')
  assert.match(zh, /目标预算/, `❌ 中文下面板标题应为中文，实际：${zh}`)
  assert.match(zh, /已花费/, `❌ 中文下应有「已花费」，实际：${zh}`)
  assert.doesNotMatch(zh, /Goal budget|Spent|Tokens/, `❌ 中文下面板不应出现英文标签：${zh}`)

  const en = panelText('en')
  assert.match(en, /Goal budget/, `❌ 英文下面板标题应为英文，实际：${en}`)
  assert.doesNotMatch(en, /目标预算|已花费/, `❌ 英文下面板不应出现中文：${en}`)
  activeLocale = 'en'
}

// ── 11. 插值：{cost} / {limit} 要被替换掉 ──
{
  remount()
  activeLocale = 'en'
  const out = render(Pill, {
    useProjection: (k: string) => (k === 'goalBudget'
      ? { budget: { tokens: 0, costUsd: 5 }, spent: { tokens: 100, costUsd: 2.5, unbilledTurns: 0 } }
      : undefined),
  }) as El
  const pillText = textOf(out)
  assert.doesNotMatch(pillText, /\{cost\}|\{limit\}|\{percent\}/, `❌ 占位符没被替换：${pillText}`)
  assert.match(pillText, /\$5/, `❌ 插值后应含上限值：${pillText}`)
  activeLocale = 'zh'
}

// ── 13. 未定价模型：面板列出它的名字，并说明费用没有计入 ──
{
  remount()
  activeLocale = 'en'
  const unpricedView = {
    budget: null,
    spent: { tokens: 1234, costUsd: 0, unbilledTurns: 0, unpricedModels: ['a/claude-sonnet'] },
  }
  const useUnpriced = (k: string) => (k === 'goalBudget' ? unpricedView : undefined)
  clickPill(render(Pill, { useProjection: useUnpriced }) as El)
  const opened = render(Pill, { useProjection: useUnpriced }) as El
  const panel = findEl(opened, n => n.props['role'] === 'dialog')
  assert.ok(panel, '❌ 找不到面板')
  const text = textOf(panel)
  assert.match(text, /claude-sonnet/, `❌ 面板应列出未定价的模型：${text}`)
  assert.match(text, /cost is not counted/, `❌ 应说明费用没有计入：${text}`)
}

// ── 14. 分模型明细：DeepSeek 显示金额，未计价的模型显示「not counted」+ token ──
{
  remount()
  activeLocale = 'en'
  const breakdownView = {
    budget: null,
    spent: {
      tokens: 537_632_218, costUsd: 3.1806, currency: 'USD', unbilledTurns: 0,
      unpricedModels: ['magpie-anthropic/cm-ais/claude-haiku-5-5'],
      models: [
        { model: 'deepseek-flash', tokens: 466_228_405, costUsd: 3.1806, priced: true },
        { model: 'magpie-anthropic/cm-ais/claude-haiku-5-5', tokens: 72_403_813, costUsd: 0, priced: false },
      ],
    },
  }
  const useBreakdown = (k: string) => (k === 'goalBudget' ? breakdownView : undefined)
  clickPill(render(Pill, { useProjection: useBreakdown }) as El)
  const opened = render(Pill, { useProjection: useBreakdown }) as El
  const panel = findEl(opened, n => n.props['role'] === 'dialog')
  assert.ok(panel, '❌ 找不到面板')
  const text = textOf(panel)
  assert.match(text, /deepseek-flash/, `❌ 明细应显示模型名：${text}`)
  assert.match(text, /\$3\.18/, `❌ 明细应显示该模型的金额：${text}`)
  assert.match(text, /not counted/, `❌ 未计价的模型应标明未计入：${text}`)
  assert.match(text, /466\.23m|466\.2m/, `❌ 应显示该模型的 token：${text}`)
}

// ── 15. 面板宽度必须等于它的上限 ──
//     钩子在「隐藏但参与布局」的首帧测量尺寸，随后才定位。若宽度由内容决定（max-content）
//     而 maxWidth 又把它压窄，测量值与最终值就不一致：align:'end' 的右缘会短一截、
//     上边距也会偏大（OBSERVED 的截图）。所以 width 与 maxWidth 必须取同一个值。
{
  remount()
  activeLocale = 'en'
  const view = { budget: null, spent: { tokens: 1, costUsd: 0.01, currency: 'USD', unbilledTurns: 0, unpricedModels: [], models: [] } }
  const useView = (k: string) => (k === 'goalBudget' ? view : undefined)
  clickPill(render(Pill, { useProjection: useView }) as El)
  const opened = render(Pill, { useProjection: useView }) as El
  const panel = findEl(opened, n => n.props['role'] === 'dialog')
  assert.ok(panel, '❌ 找不到面板')
  const style = (panel.props['style'] ?? {}) as Record<string, unknown>
  assert.equal(style['width'], style['maxWidth'], `❌ 面板宽度必须等于上限，否则测量值与渲染值不符：${String(style['width'])} vs ${String(style['maxWidth'])}`)
  assert.notEqual(style['width'], 'max-content', '❌ 不能用 max-content 定宽')
}

// ── 16. 估算金额用 ≈ 标出并附说明 ──
{
  remount()
  activeLocale = 'en'
  const view = {
    budget: null,
    spent: {
      tokens: 1000, costUsd: 1.25, currency: 'USD', unbilledTurns: 0, unpricedModels: [],
      models: [{ model: 'claude-haiku-5-5', tokens: 900, costUsd: 1.25, priced: true, estimated: true }],
    },
  }
  const useV = (k: string) => (k === 'goalBudget' ? view : undefined)
  clickPill(render(Pill, { useProjection: useV }) as El)
  const opened = render(Pill, { useProjection: useV }) as El
  const panel = findEl(opened, n => n.props['role'] === 'dialog')
  assert.ok(panel, '❌ 找不到面板')
  const text = textOf(panel)
  assert.match(text, /≈\$1\.25/, `❌ 估算金额应带 ≈：${text}`)
  assert.match(text, /marks an estimate/, `❌ 应说明是估算：${text}`)
}

console.log('✅ client-pill.spec.ts 全部通过（13 组断言）')
console.log('   - 显示宿主给的数，不自己重算')
console.log('   - 用宿主的 Pill 原语，带 onClick / aria-haspopup / aria-expanded')
console.log('   - 点击后出现 role=dialog 明细面板')
console.log('   - 面板 portal 到 document.body（否则被 overflow 裁掉）')
console.log('   - 首帧按 MEASURE_STYLE 隐藏但仍参与布局')
console.log('   - z-index 1100，盖过模态层')
console.log('   - 全零 / 缺失 / 无 useProjection 都不渲染且不崩')
console.log('   - StateDot 状态随用量变（done / warning / error）')
console.log('   - 进度条底槽不用外层 opacity')
console.log('   - 无法归因的 turn 会在面板说明')
console.log('   - 面板 side:top + align:end，贴着 pill 向左生长')
console.log('   - 文案走 locale 字典，中英键一致，中文下显示中文')
console.log('   - {cost} / {limit} / {percent} 占位符真的被替换')
