/**
 * 账户币种识别：官方余额接口的解析，以及 Key 不泄露。全部用假的 fetch，不发真实请求。
 */
import assert from 'node:assert/strict'
import { DEEPSEEK_BALANCE_URL, detectAccountCurrency, detectDeepSeekCurrency } from '../src/currency-detect.ts'

const KEY = 'sk-test-SECRET-123'
type Call = { url: string; auth: string | undefined }

function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), auth: headers.get('Authorization') ?? undefined })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

// ── 1. 人民币账户 ──
{
  const calls: Call[] = []
  const currency = await detectDeepSeekCurrency(KEY, fakeFetch(200, {
    is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }],
  }, calls))
  assert.equal(currency, 'CNY', '❌ 人民币账户应识别为 CNY')
  assert.equal(calls[0]?.url, DEEPSEEK_BALANCE_URL, '❌ 应请求官方余额接口')
  assert.equal(calls[0]?.auth, `Bearer ${KEY}`, '❌ Key 只能放在 Authorization 头里')
}

// ── 2. 美元账户 ──
{
  const currency = await detectDeepSeekCurrency(KEY, fakeFetch(200, {
    is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.50' }],
  }, []))
  assert.equal(currency, 'USD', '❌ 美元账户应识别为 USD')
}

// ── 3. 同时出现两种币种：无法唯一判定，返回 undefined，需要配置指定 ──
{
  const currency = await detectDeepSeekCurrency(KEY, fakeFetch(200, {
    balance_infos: [{ currency: 'CNY' }, { currency: 'USD' }],
  }, []))
  assert.equal(currency, undefined, '❌ 两种币种并存时不得猜')
}

// ── 4. 没有余额记录 ──
{
  const currency = await detectDeepSeekCurrency(KEY, fakeFetch(200, { balance_infos: [] }, []))
  assert.equal(currency, undefined, '❌ 没有余额记录时不得猜')
}

// ── 5. 非 2xx：抛错，且错误信息不含 Key ──
{
  const error = await detectDeepSeekCurrency(KEY, fakeFetch(401, { error: 'unauthorized' }, [])).then(
    () => undefined,
    (e: unknown) => e,
  )
  assert.ok(error instanceof Error, '❌ 非 2xx 应抛错')
  assert.equal(String(error).includes(KEY), false, '❌ 错误信息不得包含 API Key')
}

// ── 6. 没有凭据：不发请求，返回 undefined ──
{
  const calls: Call[] = []
  assert.equal(await detectAccountCurrency(undefined, 'DEEPSEEK_API_KEY', fakeFetch(200, {}, calls)), undefined)
  assert.equal(
    await detectAccountCurrency({ resolve: async () => undefined }, 'DEEPSEEK_API_KEY', fakeFetch(200, {}, calls)),
    undefined,
  )
  assert.equal(
    await detectAccountCurrency({ resolve: async () => ({ value: '' }) }, 'DEEPSEEK_API_KEY', fakeFetch(200, {}, calls)),
    undefined,
  )
  assert.equal(calls.length, 0, '❌ 没有可用的 Key 时不应发出任何请求')
}

// ── 7. 凭据服务给出 Key：用它识别 ──
{
  const calls: Call[] = []
  const currency = await detectAccountCurrency(
    { resolve: async ref => (ref === 'DEEPSEEK_API_KEY' ? { value: KEY } : undefined) },
    'DEEPSEEK_API_KEY',
    fakeFetch(200, { balance_infos: [{ currency: 'USD' }] }, calls),
  )
  assert.equal(currency, 'USD')
  assert.equal(calls[0]?.auth, `Bearer ${KEY}`)
}

console.log('✅ currency-detect.spec.ts 全部通过（7 组断言）')
