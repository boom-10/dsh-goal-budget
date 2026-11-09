/**
 * dsh-goal-budget 的浏览器半边 —— 输入框旁的资源 pill，可点击展开明细。
 *
 * 手写、无构建步骤，格式照官方模板
 * （cordis-plugin-development/templates/decoration/client.js）。
 *
 * ## 数字全部来自宿主
 *
 * 客户端不做计价。`goalBudget` 投影带着宿主用同一个 `costOf` 算好的 `spent`
 * 和预算。**一个数字只有一个来源，显示的和阻断判定用的不可能分歧。**
 *
 * ## 面板必须 portal 到 document.body
 *
 * `useAnchoredPosition` 的契约（见其源码首行注释）是
 * 「**body-portaled** panels with a viewport fixed-position containing block」，
 * 参数注释还写着「its ancestors must not establish a containing block」。
 *
 * 内联渲染在输入框里会被 composer 的 overflow 裁掉、定位也算错 —— 0.6.0 的
 * 事故现场就是面板被切在屏幕右下角。宿主的 DialogPill 同样是
 * `createPortal(..., document.body)`。
 *
 * 另外首帧要按 `MEASURE_STYLE`（隐藏但参与布局）渲染，否则钩子量不到真实尺寸，
 * 夹取（clamp）就没有依据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-goal-budget',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const { Pill, StateDot, useAnchoredPosition, useDismissOnOutsidePointer } = P
    const { createPortal } = ReactDOM

    /**
     * 文案命名空间与字典。
     *
     * `ctx.locale.register(ns, { zh, en })` 要求**基线语言 zh 和 en 都在**
     * （见 packages/client/locale/src/client/index.ts 的 register 重载与
     * 其双语平衡校验）。占位符是 `{name}`，缺失的 key 会回退显示 key 本身。
     *
     * 官方对这条是硬要求：
     * 「Product-authored Client UI text must enter through these typed
     *   dictionaries or an already-localized primitive prop.」
     */
    const NS = 'goalBudget'
    const DICT = {
      zh: {
        title: '目标预算',
        spent: '已花费',
        tokens: 'Token',
        budget: '上限',
        binding: '先到',
        bindingCost: '费用',
        bindingTokens: 'Token',
        noCap: '未设会话上限',
        noCapHint: '用 /budget $5 或 /budget 500k 设置',
        unbilled: '{count} 轮未上报 token 用量，未计入',
        provenance: '由宿主计价，与预算判定同一套算法',
        estimatedNote: '≈ 为估算：该模型的单价由账单核对/反解而来，供应商可能对部分请求按不同价格计费（实测有按 1/5 计费的请求）',
        notCounted: '未计价',
        unpriced: '未计价：{models}（费用未计入，请在价格表里配置）',
        subagents: '本会话派生 {count} 个子代理：它们的用量不在上面的数字里（各自跑在自己的会话），但已计入上限',
        currencyUnknown: '账户币种未识别，费用暂不计入；请在配置里设置 currency（USD 或 CNY）',
        summaryNone: '本会话已花费 {cost}，未设上限',
        summaryCapped: '本会话已花费 {cost}，上限 {limit}，已用 {percent}%',
      },
      en: {
        title: 'Goal budget',
        spent: 'Spent',
        tokens: 'Tokens',
        budget: 'Budget',
        binding: 'Binding',
        bindingCost: 'cost',
        bindingTokens: 'tokens',
        noCap: 'No session cap',
        noCapHint: 'Set one with /budget $5 or /budget 500k',
        unbilled: '{count} turn(s) reported no token usage and are not counted',
        provenance: 'Priced by the host with the same math the budget gate uses',
        estimatedNote: '≈ marks an estimate: this model\'s rates come from reconciling the provider bill, and the provider may charge some requests differently (requests billed at 1/5 of the standard rate were measured)',
        notCounted: 'not counted',
        unpriced: 'No price for {models}; its cost is not counted (add it to the price table)',
        subagents: '{count} subagent(s) spawned from this session: their usage is not in the figures above (each runs in its own session) but does count toward the cap',
        currencyUnknown: 'Account currency not detected yet; cost is not counted. Set currency (USD or CNY) in the config.',
        summaryNone: 'Session spend {cost}, no cap set',
        summaryCapped: 'Session spend {cost} of {limit} budget, {percent}% used',
      },
    }

    /** 未定位的 portal 面板：隐藏但参与布局，供钩子测量真实尺寸。 */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    /**
     * 面板皮肤 —— 与宿主 stat-dialog 同款主题变量。
     * z-index 1100：宿主规定 portal 面板要盖在模态层（z 1000）之上。
     */
    const PANEL = {
      position: 'fixed',
      zIndex: 1100,
      boxSizing: 'border-box',
      // ★ 固定宽度，不用 max-content：钩子在「隐藏但参与布局」的首帧测量尺寸，
      //   宽度若由内容决定，测量值与被 max-width 压窄后的最终值不一致，
      //   align:'end' 的右缘就对不齐 pill（OBSERVED：右缘偏左、上边距偏大）。
      width: 'min(320px, calc(100vw - 24px), var(--dsh-anchored-max-width, 100vw))',
      maxWidth: 'min(320px, calc(100vw - 24px), var(--dsh-anchored-max-width, 100vw))',
      maxHeight: 'var(--dsh-anchored-max-height, none)',
      overflowX: 'hidden',
      overflowY: 'auto',
      padding: '16px',
      border: 0,
      borderRadius: 'var(--dsw-radius-lg, 12px)',
      background: 'var(--dsw-specific-menu, #212124)',
      backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.32))',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      cursor: 'default',
    }
    const TITLE = {
      display: 'flex', justifyContent: 'space-between', gap: '16px',
      marginBottom: '8px', color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 500,
    }
    const RULE = { marginBottom: '10px', borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: '16px' }
    const NUM = { fontVariantNumeric: 'tabular-nums' }
    const DIM = { opacity: 0.7 }
    const NOTE = { marginTop: '10px', fontSize: '11px', lineHeight: '16px', opacity: 0.7 }

    /**
     * 估算说明：某些模型的单价是按账单反解/核对的**估算** —— 供应商对同一次调用可能按请求
     * 不同收费（实测有请求按标准价的 1/5 计费），而会话日志里看不到这个维度。
     * 标出来，比给一个看起来精确的数字更诚实。
     */
    function estimatedLine(spent, t) {
      const anyEstimated = spent.models && spent.models.some(m => m.priced && m.estimated)
      return anyEstimated ? h('div', { style: NOTE }, t('estimatedNote')) : null
    }

    /** 金额按币种显示：人民币为 ¥，其余（含未指定）为 $。 */
    /** 模型名太长，只显示最后一段（与计价用的归一化规则一致）。 */
    function shortModel(name) {
      const tail = String(name).split(/[/:]/).pop()
      const dash = tail.lastIndexOf('--')
      return dash === -1 ? tail : tail.slice(dash + 2)
    }

    /**
     * 分模型明细：让「哪部分算了钱、哪部分没算」一眼可见。
     * 之前只给总数，看不出 DeepSeek 那部分到底有没有计价（OBSERVED 的用户反馈）。
     */
    function modelLines(spent, t) {
      if (!spent.models || spent.models.length === 0) return null
      return h('div', null, spent.models.map(m => row(
        shortModel(m.model),
        m.priced
          ? (m.estimated ? '≈' : '') + usd(m.costUsd, spent.currency) + ' · ' + num(m.tokens)
          : t('notCounted') + ' · ' + num(m.tokens),
      )))
    }

    function usd(n, currency) {
      const sym = currency === 'CNY' ? '¥' : '$'
      if (n <= 0) return sym + '0'
      return n < 0.01 ? sym + n.toFixed(4) : sym + n.toFixed(n < 1 ? 3 : 2)
    }

    function num(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2) + 'm'
      if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k'
      return String(n)
    }

    function row(label, value) {
      return h('div', { style: ROW }, h('span', null, label), h('span', { style: NUM }, value))
    }

    /** 进度条。底槽透明度只写在背景色上 —— 外层 opacity 会被子元素继承相乘。 */
    function bar(ratio, color) {
      const pct = Math.max(0, Math.min(1, ratio)) * 100
      return h('span', {
        style: {
          display: 'inline-block', width: '38px', height: '4px', borderRadius: '2px',
          background: 'color-mix(in srgb, currentColor 22%, transparent)',
          position: 'relative', overflow: 'hidden', flex: '0 0 auto',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: '0', bottom: '0', left: '0',
          width: pct + '%', background: color, borderRadius: '2px',
        },
      }))
    }

    /** 用过但没有单价的模型：列出它们，并说明费用没有计入。 */
    function unpricedLine(spent, t) {
      // 币种尚未识别：费用无法计算，明确说明，而不是显示 $0 冒充已计价。
      if (spent.currency === null && spent.tokens > 0) return h('div', { style: NOTE }, t('currencyUnknown'))
      const models = spent.unpricedModels
      if (!models || models.length === 0) return null
      return h('div', { style: NOTE }, t('unpriced', { models: models.join(', ') }))
    }

    /**
     * 子代理披露行。
     *
     * 子代理跑在自己的会话里，它的用量进不了本会话的投影，所以**上面的数字里没有它**；
     * 但宿主记账时把它计入了预算 —— 面板必须说清这两件事，否则用户会以为上限比实际松。
     */
    function subagentLine(spent, t) {
      const n = spent.children
      if (typeof n !== 'number' || n <= 0) return null
      return h('div', { style: NOTE, 'data-goal-budget-line': 'subagents' }, t('subagents', { count: n }))
    }

    function GoalBudgetPill(props) {
      const { useProjection, t } = props
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const state = typeof useProjection === 'function' ? useProjection('goalBudget') : null
      const spent = state && state.spent ? state.spent : null
      const budget = state ? state.budget : null

      // 钩子必须无条件调用（React 规则）。
      const pos = useAnchoredPosition({
        open: open && spent !== null,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        // 'end'：面板右缘贴住 pill 右缘，向左生长。
        // pill 在输入框右侧，'start' 会让面板向右铺开、看着像挂在别处。
        align: 'end',
        gap: 8,
        // 与宿主 stat-dialog 的 PANEL_MARGIN 一致，保证夹取行为相同。
        margin: 12,
        // 内容一变就重测：首帧是隐藏测量的，之后模型明细、未计价行都会改变高度。
        // ★ 必须判空：spent 在这一行可能还是 null（下面的 return null 在钩子之后）。
        layoutKey: spent === null ? 'none'
          : String(spent.tokens) + ':' + String(spent.costUsd) + ':'
            + String(spent.models ? spent.models.length : 0) + ':' + String(spent.unpricedModels ? spent.unpricedModels.length : 0)
            + ':' + String(spent.unbilledTurns) + ':' + String(spent.children ? spent.children : 0),
      })
      useDismissOnOutsidePointer(rootRef, open, setOpen)

      if (spent === null) return null
      // 子代理披露行也算内容：只有它非零时同样要显示 pill。
      if (spent.costUsd === 0 && spent.tokens === 0 && spent.unbilledTurns === 0 && !(spent.children > 0)) return null

      // 命中哪一维用哪一维 —— 与宿主 checkBudget「谁先到算谁」一致。
      let ratio = null
      let limitText = null
      let binding = null
      if (budget !== null && budget !== undefined) {
        const dims = []
        if (budget.costUsd > 0) dims.push({ r: spent.costUsd / budget.costUsd, limit: usd(budget.costUsd, budget.costCurrency), dim: 'cost' })
        if (budget.tokens > 0) dims.push({ r: spent.tokens / budget.tokens, limit: num(budget.tokens), dim: 'tokens' })
        if (dims.length > 0) {
          const worst = dims.reduce((a, b) => (b.r > a.r ? b : a))
          ratio = worst.r
          limitText = worst.limit
          binding = worst.dim
        }
      }

      const over = ratio !== null && ratio >= 1
      const near = ratio !== null && ratio >= 0.8 && !over
      const color = over ? 'var(--dsw-alias-state-error, #e5534b)'
        : near ? 'var(--dsw-alias-state-warning, #d29922)'
        : 'var(--dsw-alias-state-success, #4a9eff)'
      const dotState = over ? 'error' : near ? 'warning' : 'done'

      const summary = ratio === null
        ? t('summaryNone', { cost: usd(spent.costUsd, spent.currency) })
        : t('summaryCapped', { cost: usd(spent.costUsd, spent.currency), limit: limitText, percent: Math.round(ratio * 100) })

      const pct = ratio === null ? null : Math.round(ratio * 100)

      const panel = open
        ? createPortal(
            h('div', {
              ref: panelRef,
              role: 'dialog',
              'aria-label': summary,
              style: pos === null ? Object.assign({}, PANEL, MEASURE_STYLE) : Object.assign({}, PANEL, pos),
            },
              h('div', { style: TITLE },
                h('span', null, t('title')),
                pct === null ? null : h('span', { style: NUM }, pct + '%')),
              h('div', { style: RULE }),
              modelLines(spent, t),
              row(t('spent'), usd(spent.costUsd, spent.currency)),
              row(t('tokens'), num(spent.tokens)),
              budget === null || budget === undefined
                ? h('div', { style: Object.assign({}, NOTE, { marginTop: '2px' }) },
                    h('div', null, t('noCap')),
                    h('div', { style: { opacity: 0.8 } }, t('noCapHint')))
                : h('div', null,
                    row(t('budget'), limitText),
                    row(t('binding'), t(binding === 'cost' ? 'bindingCost' : 'bindingTokens'))),
              spent.unbilledTurns > 0
                ? h('div', { style: NOTE }, t('unbilled', { count: spent.unbilledTurns }))
                : null,
              h('div', { style: NOTE }, t('provenance')),
              unpricedLine(spent, t),
              estimatedLine(spent, t),
              subagentLine(spent, t),
            ),
            document.body,
          )
        : null

      return h('span', { ref: rootRef, style: { display: 'inline-flex' } },
        h(Pill, {
          onClick: () => { setOpen(!open) },
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': summary,
          title: summary,
          'data-goal-budget-pill': 'spend',
        },
          h(StateDot, { state: dotState, size: 8 }),
          h('span', null, usd(spent.costUsd, spent.currency)),
          limitText === null ? null : h('span', { style: { opacity: 0.55 } }, '/ ' + limitText),
          ratio === null ? null : bar(ratio, color),
        ),
        panel,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // ctx.effect 让字典随插件卸载一起撤掉。缺了它就直接注册，
        // 不让「拿不到 effect」变成加载期异常（那会让整个 fiber 失败）。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'goal-budget: dictionaries')
        } else {
          ctx.locale.register(NS, DICT)
        }

        // bind 返回的函数每个命名空间只有一份、身份稳定，所以可以安全地随
        // 闭包传进组件，不会破坏 memo。
        const t = ctx.locale.bind(NS)
        // 只创建一次：每次 apply 都新建组件会打断 React 的协调。
        const Pill = (props) => GoalBudgetPill(Object.assign({}, props, { t }))

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'goal-budget',
            order: 10,
            inject: () => ({}),
          }, Pill),
        )
      },
    }
  },
})
