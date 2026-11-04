/**
 * dsh-goal-budget 的浏览器半边 —— 输入框旁的资源 pill。
 *
 * 手写、无构建步骤，照官方模板的格式
 * （packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/client.js）。
 *
 * ## 数字全部来自宿主，客户端不做计价
 *
 * 0.4.x 曾让客户端自己从 `tokenUsage` 的合计值算花费，结果是错的：
 * 正确口径是**逐条** `max(0, input − cacheRead)` 累加，而合计相减在
 * cacheRead 远大于 input 的会话上会归零（实测差 15%+）。
 *
 * 现在 `goalBudget` 投影已经把宿主算好的 `spent` 送过来，
 * 单价和算法与阻断判定完全同源。**一个数字只有一个来源。**
 */
window.__ModuleLoader__.load({
  id: 'dsh-goal-budget',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function usd(n) {
      if (n <= 0) return '$0'
      return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(n < 1 ? 3 : 2)
    }

    function num(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm'
      if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k'
      return String(n)
    }

    const S = {
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        fontSize: '11px', lineHeight: '16px', padding: '0 6px',
        color: 'var(--dsh-text-secondary, #888)', whiteSpace: 'nowrap',
      },
      dot: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto' },
    }

    /**
     * 进度条。
     *
     * ⚠️ 底槽的透明度只写在**背景色**上，不能用外层 `opacity` —— 那会被子元素
     * 继承并相乘，填充层和底槽一样透明，整条几乎看不见（0.4.x 的 bug）。
     */
    function bar(ratio, color) {
      const pct = Math.max(0, Math.min(1, ratio)) * 100
      return h('span', {
        style: {
          display: 'inline-block', width: '34px', height: '4px', borderRadius: '2px',
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

    /**
     * @param {object} props - slot 传下来的 props；用 `useProjection` 读会话投影。
     */
    function GoalBudgetPill(props) {
      const { useProjection } = props
      if (typeof useProjection !== 'function') return null

      // 宿主算好的上限 + 花费，同一个口径。
      const state = useProjection('goalBudget')
      if (state === undefined || state === null) return null
      const spent = state.spent
      if (spent === undefined) return null
      if (spent.costUsd === 0 && spent.tokens === 0 && spent.unbilledTurns === 0) return null

      // 命中哪一维用哪一维 —— 与宿主 checkBudget 的「谁先到算谁」一致。
      let ratio = null
      let limitText = null
      const budget = state.budget
      if (budget !== null && budget !== undefined) {
        const dims = []
        if (budget.costUsd > 0) dims.push({ r: spent.costUsd / budget.costUsd, text: usd(budget.costUsd) })
        if (budget.tokens > 0) dims.push({ r: spent.tokens / budget.tokens, text: num(budget.tokens) })
        if (dims.length > 0) {
          const worst = dims.reduce((a, b) => (b.r > a.r ? b : a))
          ratio = worst.r
          limitText = worst.text
        }
      }

      const over = ratio !== null && ratio >= 1
      const near = ratio !== null && ratio >= 0.8 && !over
      const color = over ? 'var(--dsh-danger, #e5534b)'
        : near ? 'var(--dsh-warning, #d29922)'
        : 'var(--dsh-accent, #4a9eff)'

      const lines = ['Session spend (from the host, same math the budget gate uses)']
      lines.push('tokens ' + num(spent.tokens) + ' · ' + usd(spent.costUsd))
      if (spent.unbilledTurns > 0) {
        lines.push(spent.unbilledTurns + ' turn(s) reported no usage and are not counted')
      }
      if (limitText !== null) lines.push('Budget ' + limitText + ' — ' + Math.round(ratio * 100) + '% used')
      else lines.push('No session cap set — use /budget')

      return h('span', { style: S.pill, title: lines.join('\n'), 'data-goal-budget-pill': 'spend' },
        h('span', { style: Object.assign({}, S.dot, { background: color }) }),
        h('span', null, usd(spent.costUsd)),
        limitText === null ? null : h('span', { style: { opacity: 0.55 } }, '/ ' + limitText),
        ratio === null ? null : bar(ratio, color),
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
