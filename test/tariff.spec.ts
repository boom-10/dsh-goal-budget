/**
 * DeepSeek 官方价目、峰谷时段、节假日与模型别名（纯函数）。
 */
import assert from 'node:assert/strict'
import {
  bandAt, calendarCovers, canonicalDeepSeekModel, costOfTariff, DEEPSEEK_TARIFFS, digestOf, ratesFor,
} from '../src/tariff.ts'
import { COVERED_YEARS, HOLIDAY_SOURCE, OFF_DAYS } from '../src/holiday-calendar.ts'

const H = 3_600_000
/** 北京时间 → 时间戳。 */
const bj = (y: number, mo: number, d: number, hh: number, mm = 0) => Date.UTC(y, mo - 1, d, hh - 8, mm)
const weekdayOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay()

// ── 1. 高峰窗口：北京时间周一至周五，9–12 与 14–18 点 ──
{
  const tue = [2026, 11, 3] as const // 周二
  assert.equal(weekdayOf(...tue), 2, '测试前提：2026-11-03 应为周二')
  assert.equal(bandAt(bj(...tue, 8, 59)), 'offPeak', '❌ 8:59 应为空闲')
  assert.equal(bandAt(bj(...tue, 9, 0)), 'peak', '❌ 9:00 起应为高峰')
  assert.equal(bandAt(bj(...tue, 11, 59)), 'peak', '❌ 11:59 仍应为高峰')
  assert.equal(bandAt(bj(...tue, 12, 0)), 'offPeak', '❌ 12:00 起应为空闲')
  assert.equal(bandAt(bj(...tue, 13, 59)), 'offPeak', '❌ 13:59 应为空闲')
  assert.equal(bandAt(bj(...tue, 14, 0)), 'peak', '❌ 14:00 起应为高峰')
  assert.equal(bandAt(bj(...tue, 17, 59)), 'peak', '❌ 17:59 仍应为高峰')
  assert.equal(bandAt(bj(...tue, 18, 0)), 'offPeak', '❌ 18:00 起应为空闲')
}

// ── 2. 周末全天空闲 ──
{
  assert.equal(bandAt(bj(2026, 11, 7, 10)), 'offPeak', '❌ 周六 10:00 应为空闲')
  assert.equal(bandAt(bj(2026, 11, 8, 10)), 'offPeak', '❌ 周日 10:00 应为空闲')
}

// ── 3. 法定节假日（工作日）全天空闲；同样的工作日若不放假则为高峰 ──
{
  const holiday = OFF_DAYS.find(d => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number]
    const w = weekdayOf(y, m, day)
    return w >= 1 && w <= 5
  })
  assert.ok(holiday !== undefined, '测试前提：日历里应有落在工作日的放假日')
  const [y, m, d] = holiday.split('-').map(Number) as [number, number, number]
  assert.equal(bandAt(bj(y, m, d, 10)), 'offPeak', `❌ 法定节假日 ${holiday} 10:00 应为空闲`)

  const ordinary = [2026, 3, 3] as const // 周二，不在放假表里
  assert.equal(weekdayOf(...ordinary), 2, '测试前提：2026-03-03 应为周二')
  assert.equal(OFF_DAYS.includes('2026-03-03'), false, '测试前提：2026-03-03 不应是放假日')
  assert.equal(bandAt(bj(...ordinary, 10)), 'peak', '❌ 普通工作日 10:00 应为高峰')
}

// ── 4. 模型别名：旧名折叠到计价模型；未知名字不顶替 ──
{
  assert.equal(canonicalDeepSeekModel('deepseek-flash'), 'deepseek-flash')
  assert.equal(canonicalDeepSeekModel('deepseek-v4-flash'), 'deepseek-flash', '❌ 旧名 deepseek-v4-flash 应按 Flash 计价')
  assert.equal(canonicalDeepSeekModel('deepseek-v4-flash-vision-exp'), 'deepseek-flash', '❌ 旧名 vision-exp 应按 Flash 计价')
  assert.equal(canonicalDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(canonicalDeepSeekModel('gpt-5'), undefined, '❌ 非 DeepSeek 模型不得计价')
  assert.equal(canonicalDeepSeekModel('constructor'), undefined, '❌ 原型链上的名字不得命中')
  assert.equal(canonicalDeepSeekModel(undefined), undefined)
}

// ── 4b. 网关前缀：去掉 `供应商/` 再匹配；用户别名优先；路由组合名不得误判 ──
{
  assert.equal(canonicalDeepSeekModel('cm-ais/deepseek-v4.1-flash'), 'deepseek-flash', '❌ 去掉供应商前缀后应能识别')
  assert.equal(canonicalDeepSeekModel('deepseek-v4.1-flash'), 'deepseek-flash', '❌ 官方版本名 V4.1-Flash 应识别')
  assert.equal(canonicalDeepSeekModel('cm-ais/deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(canonicalDeepSeekModel('cm-ais/deepseek-flash'), 'deepseek-flash', '❌ 带前缀的官方名应识别')
  assert.equal(canonicalDeepSeekModel('group/smart-split'), undefined, '❌ 路由组合名不得算成 DeepSeek')
  assert.equal(canonicalDeepSeekModel('my-flash', { 'my-flash': 'deepseek-flash' }), 'deepseek-flash', '❌ 用户别名应生效')
  assert.equal(canonicalDeepSeekModel('MY-FLASH', { 'my-flash': 'deepseek-flash' }), 'deepseek-flash', '❌ 别名匹配应大小写不敏感')
  assert.equal(canonicalDeepSeekModel('deepseek-flash', { 'deepseek-flash': 'deepseek-v4-pro' }), 'deepseek-v4-pro', '❌ 用户别名应优先于内置')
  assert.equal(canonicalDeepSeekModel('cm-ais/other-model', { 'cm-ais/other-model': 'deepseek-v4-pro' }), 'deepseek-v4-pro', '❌ 带前缀的别名应生效')
  // ★ 真实会话（session-2d3becaf）里出现过的三种路由写法
  assert.equal(canonicalDeepSeekModel('ais/llm-gateway--deepseek-v4-flash'), 'deepseek-flash', '❌ 网关用 -- 分隔时应识别')
  assert.equal(canonicalDeepSeekModel('deepseek-official/deepseek-v4-flash'), 'deepseek-flash', '❌ 官方线路的前缀写法应识别')
  assert.equal(canonicalDeepSeekModel('ais/llm-gateway--kimi-k3'), undefined, '❌ 网关上的非 DeepSeek 模型不得计价')
  assert.equal(canonicalDeepSeekModel('vendor:deepseek-v4-pro'), 'deepseek-v4-pro', '❌ 冒号分隔应识别')
}

// ── 5. 官方价目：峰值 = 空闲价的 2 倍（官方脚注），数值与官方页面一致 ──
{
  assert.deepEqual(ratesFor('deepseek-flash', 'CNY', 'offPeak'), { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.deepEqual(ratesFor('deepseek-flash', 'USD', 'peak'), { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 })
  assert.deepEqual(ratesFor('deepseek-v4-pro', 'CNY', 'peak'), { cacheHit: 0.3, cacheMiss: 9, output: 27 })
  for (const currency of ['USD', 'CNY'] as const) {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro'] as const) {
      const off = DEEPSEEK_TARIFFS[currency][model].offPeak
      const peak = DEEPSEEK_TARIFFS[currency][model].peak
      for (const k of ['cacheHit', 'cacheMiss', 'output'] as const) {
        assert.ok(Math.abs(peak[k] - 2 * off[k]) < 1e-12, `❌ ${currency} ${model} ${k}：峰值应为空闲价的 2 倍`)
      }
    }
  }
}

// ── 6. ★ 真实会话 2d3becaf 的合计（未命中 13,150,225；缓存命中 651,227,392；输出 712,512）──
{
  const u = { inputTokens: 13_150_225, cacheReadTokens: 651_227_392, cacheWriteTokens: 0, outputTokens: 712_512 }
  const usd = costOfTariff(u, ratesFor('deepseek-flash', 'USD', 'offPeak'))
  assert.ok(Math.abs(usd - 4.353723126) < 1e-9, `❌ 美元非高峰应为 $4.3537，得到 ${usd}`)
  // 手算：13.150225 × 1 + 651.227392 × 0.02 + 0.712512 × 4 = 29.02482084 元
  const cny = costOfTariff(u, ratesFor('deepseek-flash', 'CNY', 'offPeak'))
  assert.ok(Math.abs(cny - 29.02482084) < 1e-6, `❌ 人民币非高峰应为 ¥29.0248，得到 ${cny}`)
  const cnyPeak = costOfTariff(u, ratesFor('deepseek-flash', 'CNY', 'peak'))
  assert.ok(Math.abs(cnyPeak - 2 * 29.02482084) < 1e-6, '❌ 人民币高峰应为空闲的 2 倍')
}

// ── 7. 日历覆盖与来源标注 ──
{
  assert.equal(calendarCovers(bj(2026, 6, 1, 10)), true, '❌ 2026 年应在覆盖范围内')
  assert.equal(calendarCovers(bj(2027, 6, 1, 10)), false, '❌ 2027 年不在覆盖范围内，应提示')
  assert.deepEqual([...COVERED_YEARS], [2025, 2026])
  assert.ok(HOLIDAY_SOURCE.includes('dcecbce230a57639cc8967ec9e2465e744880fd8'), '❌ 日历应标明固定版本')
}

// ── 8. 版本摘要稳定，且随内容变化 ──
{
  assert.equal(digestOf('abc'), digestOf('abc'))
  assert.notEqual(digestOf('abc'), digestOf('abd'))
  assert.ok(digestOf('x') >= 0 && digestOf('x') < 1_000_000)
}

console.log('✅ tariff.spec.ts 全部通过（8 组断言）')
console.log('   - 峰谷窗口与边界；周末与法定节假日全天空闲')
console.log('   - 模型别名与原型链防护；官方价目的峰值 = 2 倍')
console.log('   - 真实会话：美元 $4.3537，人民币 ¥29.0248（非高峰）')
