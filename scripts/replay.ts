/**
 * 用**真实会话日志**回放投影。
 *
 * 为什么需要它：单元测试用的是合成事件序列，而真实日志里有上万条事件、多模型切换、
 * 网关前缀、工具调用交错。这个脚本把真实日志喂给 `goalBudget` 投影，打印计价结果，
 * 用来验证插件在真实数据上的行为。
 *
 * 用法：
 *   node --experimental-strip-types scripts/replay.ts <会话.jsonl> [USD|CNY] [official|flat]
 *
 * 日志是 zstd 压缩的（session.jsonl.zstd）。解压方式（系统 Python 3.14+）：
 *   python3 -c "from compression import zstd,pathlib; \
 *     p=pathlib.Path('<session.jsonl.zstd>'); pathlib.Path('/tmp/s.jsonl').write_bytes(zstd.decompress(p.read_bytes()))"
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGoalBudgetProjection } from '../src/budget-projection.ts'
import type { Currency } from '../src/tariff.ts'

const [file, currencyArg, modeArg] = process.argv.slice(2)
if (file === undefined) {
  console.error('用法: node --experimental-strip-types scripts/replay.ts <会话.jsonl> [USD|CNY]')
  process.exit(1)
}
const currency = (currencyArg ?? 'USD') as Currency

// mode: 缺省 official（官方峰谷）；`flat` = 网关口径（固定单价，不区分峰谷）。
const peakPricing = modeArg !== 'flat'
const def = createGoalBudgetProjection({ currency: () => currency, peakPricing })
let state = def.init()
let events = 0
const routes = new Set<string>()

const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
for await (const line of lines) {
  if (line.length === 0) continue
  const event = JSON.parse(line) as { type?: string; time?: number; data?: unknown }
  events++
  if (event.type === 'request/header') {
    const cfg = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } })?.header?.config
    routes.add(`${String(cfg?.provider)}/${String(cfg?.model)}`)
  }
  state = def.apply(state, event)
}

const view = def.wire.view(state)
const money = (n: number) => `${currency === 'CNY' ? '¥' : '$'}${n.toFixed(4)}`
console.log(`事件 ${events.toLocaleString('en-US')} 条 · 路线 ${routes.size} 条 · 口径 ${peakPricing ? 'official（峰谷）' : 'flat（网关固定价）'}`)
for (const r of routes) console.log(`  路线: ${r}`)
console.log(`token 合计: ${view.spent.tokens.toLocaleString('en-US')}`)
console.log(`费用（${currency}）: ${money(view.spent.costUsd)}`)
console.log(`缺 usage 的轮次: ${view.spent.unbilledTurns}`)
console.log(`不计价的模型: ${view.spent.unpricedModels.length === 0 ? '（无）' : view.spent.unpricedModels.join(', ')}`)
console.log('按模型与时段分桶:')
for (const b of [...state.buckets].sort((x, y) => (x.model + x.band < y.model + y.band ? -1 : 1))) {
  const total = b.uncached + b.cacheRead + b.cacheWrite + b.output
  console.log(`  ${b.model.padEnd(17)} ${b.band.padEnd(8)} token ${String(total).padStart(12)}（未命中 ${b.uncached} · 缓存 ${b.cacheRead} · 输出 ${b.output}）`)
}
