/**
 * dsh-goal-budget 的浏览器半边 —— 输入框旁的资源 pill，可点击展开明细。
 *
 * 手写、无构建步骤，格式照官方模板
 * （cordis-plugin-development/templates/decoration/client.js）。
 *
 * ## 数字全部来自宿主
 *
 * 客户端不做计价。`goalBudget` 投影带着宿主用同一个 `costOf` 算好的 `spent`，
 * 以及预算。**一个数字只有一个来源，显示的和阻断判定用的不可能分歧。**
 *
 * ## 用的宿主原语
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 在 shell 的 baseline 模块表里
 * （不必写进 `dsh.client.external`），所以能直接用 `Pill` / `StateDot` /
 * `useAnchoredPosition` / `useDismissOnOutsidePointer` —— 外观、键盘可达性、
 * 定位、点击外部关闭都和宿主自己的 usage pill 一致，不用自己糊一套。
 */
window.__ModuleLoader__.load({
  id: 'dsh-goal-budget',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const { Pill, StateDot, useAnchoredPosition, useDismissOnOutsidePointer } = P

    function usd(n) {
      if (n <= 0) return '$0'
      return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(n < 1 ? 3 : 2)
    }

    function num(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2) + 'm'
      if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k'
      return String(n)
    }

    const PANEL = {
      position: 'fixed', zIndex: 50, minWidth: '260px', maxWidth: '340px',
      padding: '10px 12px', borderRadius: '8px',
      background: 'var(--dsh-surface-raised, var(--dsh-surface, #1c1c1f))',
      border: '1px solid var(--dsh-border, rgba(128,128,128,.28))',
      boxShadow: '0 8px 24px rgba(0,0,0,.28)',
      color: 'var(--dsh-text, inherit)', fontSize: '12px', lineHeight: '1.6',
    }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: '16px' }
    const DIM = { opacity: 0.62 }

    function row(label, value, dim) {
      return h('div', { style: ROW },
        h('span', { style: dim ? DIM : undefined }, label),
        h('span', null, value))
    }

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

      // 先算数据再挂钩子 —— 钩子必须无条件调用（React 规则）。
      const state = typeof useProjection === 'function' ? useProjection('goalBudget') : null
      const spent = state && state.spent ? state.spent : null
      const budget = state ? state.budget : null

      const pos = useAnchoredPosition({
        open: open && spent !== null,
        anchorRef: rootRef, panelRef,
        side: 'top', align: 'start', gap: 8, margin: 8,
      })
      useDismissOnOutsidePointer(rootRef, open, setOpen)

      if (spent === null) return null
      if (spent.costUsd === 0 && spent.tokens === 0 && spent.unbilledTurns === 0) return null

      // 命中哪一维用哪一维 —— 与宿主 checkBudget「谁先到算谁」一致。
      let ratio = null
      let limitText = null
      let usedText = null
      if (budget !== null && budget !== undefined) {
        const dims = []
        if (budget.costUsd > 0) {
          dims.push({ r: spent.costUsd / budget.costUsd, limit: usd(budget.costUsd), used: usd(spent.costUsd), dim: 'cost' })
        }
        if (budget.tokens > 0) {
          dims.push({ r: spent.tokens / budget.tokens, limit: num(budget.tokens), used: num(spent.tokens), dim: 'tokens' })
        }
        if (dims.length > 0) {
          const worst = dims.reduce((a, b) => (b.r > a.r ? b : a))
          ratio = worst.r
          limitText = worst.limit
          usedText = worst.used
        }
      }

      const over = ratio !== null && ratio >= 1
      const near = ratio !== null && ratio >= 0.8 && !over
      const color = over ? 'var(--dsh-danger, #e5534b)'
        : near ? 'var(--dsh-warning, #d29922)'
        : 'var(--dsh-accent, #4a9eff)'
      const dotState = over ? 'error' : near ? 'warning' : 'done'

      const summary = ratio === null
        ? `Session spend ${usd(spent.costUsd)} — no cap set, use /budget`
        : `Session spend ${usedText} of ${limitText} budget, ${Math.round(ratio * 100)}% used`

      const panel = open && pos !== null ? h('div', {
        ref: panelRef, style: Object.assign({}, PANEL, pos), role: 'dialog', 'aria-label': summary,
      },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'Goal budget'),
        row('Spent', usd(spent.costUsd)),
        row('Tokens', num(spent.tokens)),
        budget === null || budget === undefined
          ? h('div', { style: Object.assign({}, DIM, { marginTop: '6px' }) },
              'No session cap. Run /budget $5 or /budget 500k to set one.')
          : h('div', { style: { marginTop: '6px' } },
              row('Budget', limitText),
              row('Used', Math.round(ratio * 100) + '%'),
              usedText === limitText ? null : row('Against', usedText, true)),
        spent.unbilledTurns > 0
          ? h('div', { style: Object.assign({}, DIM, { marginTop: '6px' }) },
              spent.unbilledTurns + ' turn(s) reported no token usage and are not counted.')
          : null,
        h('div', { style: Object.assign({}, DIM, { marginTop: '6px', fontSize: '11px' }) },
          'Priced by the host with the same math the gate uses.'),
      ) : null

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
