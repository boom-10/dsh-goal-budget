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
      width: 'max-content',
      minWidth: 'min(240px, calc(100vw - 24px), var(--dsh-anchored-max-width, 100vw))',
      maxWidth: 'min(340px, calc(100vw - 24px), var(--dsh-anchored-max-width, 100vw))',
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

    function usd(n) {
      if (n <= 0) return '$0'
      return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(n < 1 ? 3 : 2)
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

    function GoalBudgetPill(props) {
      const { useProjection } = props
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
        align: 'start',
        gap: 8,
        margin: 8,
      })
      useDismissOnOutsidePointer(rootRef, open, setOpen)

      if (spent === null) return null
      if (spent.costUsd === 0 && spent.tokens === 0 && spent.unbilledTurns === 0) return null

      // 命中哪一维用哪一维 —— 与宿主 checkBudget「谁先到算谁」一致。
      let ratio = null
      let limitText = null
      let binding = null
      if (budget !== null && budget !== undefined) {
        const dims = []
        if (budget.costUsd > 0) dims.push({ r: spent.costUsd / budget.costUsd, limit: usd(budget.costUsd), dim: 'cost' })
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
        ? `Session spend ${usd(spent.costUsd)}, no cap set`
        : `Session spend ${usd(spent.costUsd)} of ${limitText} budget, ${Math.round(ratio * 100)} percent used`

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
                h('span', null, 'Goal budget'),
                pct === null ? null : h('span', { style: NUM }, pct + '%')),
              h('div', { style: RULE }),
              row('Spent', usd(spent.costUsd)),
              row('Tokens', num(spent.tokens)),
              budget === null || budget === undefined
                ? h('div', { style: NOTE }, 'No session cap. Run /budget $5 or /budget 500k to set one.')
                : h('div', null,
                    row('Budget', limitText),
                    row('Binding', binding === 'cost' ? 'cost' : 'tokens')),
              spent.unbilledTurns > 0
                ? h('div', { style: NOTE },
                    spent.unbilledTurns + ' turn(s) reported no token usage and are not counted.')
                : null,
              h('div', { style: NOTE },
                'Priced by the host with the same math the budget gate uses.'),
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
          h('span', null, usd(spent.costUsd)),
          limitText === null ? null : h('span', { style: { opacity: 0.55 } }, '/ ' + limitText),
          ratio === null ? null : bar(ratio, color),
        ),
        panel,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'goal-budget',
            order: 10,
            inject: () => ({}),
          }, GoalBudgetPill),
        )
      },
    }
  },
})
