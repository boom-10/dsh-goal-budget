/**
 * dsh-goal-budget 的浏览器半边 —— 一个显示本会话花费的 pill。
 *
 * 手写、无构建步骤，照官方模板的格式
 * （packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/client.js）。
 *
 * 数据来源：宿主已有的 `tokenUsage` 会话投影
 * （packages/llm/token-meter/src/usage-projection.ts）。它已经把
 * 「未命中缓存的输入」和「缓存命中的输入」分成两栏 —— 正是计价需要的区分。
 */
window.__ModuleLoader__.load({
  id: 'dsh-goal-budget',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 与宿主同源的默认单价（美元 / 百万 token）。
    // 客户端读不到 profile 配置，所以这里的数字是默认值；
    // 精确值以宿主端 /budget 的计算为准，pill 只做量级提示。
    const PRICE = { input: 0.15, output: 0.6, cacheRead: 0.003 }
    const M = 1e6

    function usd(n) {
      if (n <= 0) return '$0'
      return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(n < 1 ? 3 : 2)
    }

    function tokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm'
      if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k'
      return String(n)
    }

    const S = {
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        fontSize: '11px', lineHeight: '16px', padding: '0 6px',
        color: 'var(--dsh-text-secondary, #888)',
        whiteSpace: 'nowrap',
      },
      dot: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto' },
    }

    /**
     * @param {object} props - slot 传下来的 props（见 ui-chat 的 StatPillProps）。
     *   用到 `useProjection` 读会话投影；没有它就不渲染，不让客户端崩。
     */
    function GoalBudgetPill(props) {
      const { useProjection } = props
      if (typeof useProjection !== 'function') return null

      const usage = useProjection('tokenUsage')
      if (usage === undefined || usage === null) return null

      const t = usage.totals
      if (t === undefined) return null

      const total = t.uncachedInputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens
      // 全零时不占位（和宿主 UsagePill 的处理一致）
      if (total === 0) return null

      const cost =
        (t.uncachedInputTokens / M) * PRICE.input +
        (t.outputTokens / M) * PRICE.output +
        (t.cacheReadTokens / M) * PRICE.cacheRead
      const billedInput = t.uncachedInputTokens + t.cacheReadTokens
      const hit = billedInput > 0 ? Math.round((t.cacheReadTokens / billedInput) * 100) : null

      const title =
        'Session spend (estimated)\n' +
        'input ' + tokens(t.uncachedInputTokens) + ' · cache read ' + tokens(t.cacheReadTokens) +
        ' · output ' + tokens(t.outputTokens) + (hit === null ? '' : ' · cache hit ' + hit + '%') +
        '\nSet a cap with /budget'

      return h('span', { style: S.pill, title, 'data-goal-budget-pill': 'spend' },
        h('span', { style: Object.assign({}, S.dot, { background: 'var(--dsh-accent, #4a9eff)' }) }),
        h('span', null, usd(cost)),
        hit === null ? null : h('span', { style: { opacity: 0.6 } }, '· ' + hit + '%'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'goal-budget',
            // 排在宿主已有的 activity(0) / usage(1) 之后
            order: 10,
            inject: () => ({}),
          }, GoalBudgetPill),
        )
      },
    }
  },
})

