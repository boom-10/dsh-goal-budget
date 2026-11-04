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

    /** 预算进度条：一段填充 + 一段底槽。 */
    function bar(ratio) {
      const pct = Math.max(0, Math.min(1, ratio)) * 100
      return h('span', {
        style: {
          display: 'inline-block', width: '36px', height: '4px', borderRadius: '2px',
          background: 'currentColor', opacity: 0.25, position: 'relative', overflow: 'hidden',
        },
      }, h('span', {
        style: {
          position: 'absolute', inset: '0 auto 0 0', width: pct + '%',
          background: 'currentColor', opacity: 4, borderRadius: '2px',
        },
      }))
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

      // 本会话通过 /budget 设的上限；null 表示没设过（此时可能仍有 profile 默认，
      // 但客户端读不到 profile 配置，所以不显示分母）。
      const budget = typeof props.useProjection === 'function' ? props.useProjection('goalBudget') : null

      // 命中哪一维就用哪一维算比例 —— 和宿主端 checkBudget 的语义一致（谁先到算谁）。
      let ratio = null
      let limitText = null
      if (budget !== null && budget !== undefined) {
        const dims = []
        if (budget.costUsd > 0) dims.push({ r: cost / budget.costUsd, text: usd(budget.costUsd) })
        if (budget.tokens > 0) {
          const totalTokens = t.uncachedInputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens
          dims.push({ r: totalTokens / budget.tokens, text: tokens(budget.tokens) })
        }
        if (dims.length > 0) {
          const worst = dims.reduce((a, b) => (b.r > a.r ? b : a))
          ratio = worst.r
          limitText = worst.text
        }
      }

      const title =
        'Session spend (estimated)\n' +
        'input ' + tokens(t.uncachedInputTokens) + ' · cache read ' + tokens(t.cacheReadTokens) +
        ' · output ' + tokens(t.outputTokens) + (hit === null ? '' : ' · cache hit ' + hit + '%') +
        (limitText === null ? '' : '\nBudget ' + limitText + ' (' + Math.round(ratio * 100) + '% used)') +
        '\nSet a cap with /budget'

      const near = ratio !== null && ratio >= 0.8
      const over = ratio !== null && ratio >= 1

      return h('span', { style: S.pill, title, 'data-goal-budget-pill': 'spend' },
        h('span', {
          style: Object.assign({}, S.dot, {
            background: over ? 'var(--dsh-danger, #e5534b)'
              : near ? 'var(--dsh-warning, #d29922)'
              : 'var(--dsh-accent, #4a9eff)',
          }),
        }),
        h('span', null, usd(cost)),
        limitText === null ? null : h('span', { style: { opacity: 0.6 } }, '/ ' + limitText),
        ratio === null ? null : bar(ratio),
        hit === null ? null : h('span', { style: { opacity: 0.5 } }, hit + '%'),
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

