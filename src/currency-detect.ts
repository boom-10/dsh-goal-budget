/**
 * 账户币种识别。
 *
 * DeepSeek 官方余额接口 `GET /user/balance` 返回 `balance_infos[].currency`，取值 `CNY` 或 `USD`
 * （https://api-docs.deepseek.com/api/get-user-balance）。只对 DeepSeek 官方线路有效；
 * 网关线路的币种请在配置里指定。API Key 只在请求头里使用，不写日志，也不写进错误信息。
 */
import type { Currency } from './tariff.ts'

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 凭据服务的最小形状（与 DSH 的 credentials 服务一致）。 */
export interface CredentialsService {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>
}

/**
 * 用一把 DeepSeek API Key 查询账户币种。
 *
 * @returns 唯一的币种；余额记录为空、或同时出现两种币种时返回 undefined（需要在配置里指定）。
 * @throws 接口返回非 2xx 或网络失败时抛出，错误信息不含 Key。
 */
export async function detectDeepSeekCurrency(apiKey: string, fetchFn: typeof fetch = fetch): Promise<Currency | undefined> {
  const response = await fetchFn(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`DeepSeek 余额接口返回 HTTP ${response.status}`)
  const body = (await response.json()) as { balance_infos?: ReadonlyArray<{ currency?: unknown }> }
  const codes = new Set(
    (body.balance_infos ?? []).map(info => info.currency).filter((c): c is string => typeof c === 'string'),
  )
  if (codes.size !== 1) return undefined
  const [code] = [...codes]
  return code === 'CNY' || code === 'USD' ? code : undefined
}

/**
 * 从凭据服务取出 Key，再识别币种。没有 Key 时返回 undefined，不发请求。
 */
export async function detectAccountCurrency(
  creds: CredentialsService | undefined,
  ref: string,
  fetchFn?: typeof fetch,
): Promise<Currency | undefined> {
  if (creds === undefined) return undefined
  const hit = await creds.resolve(ref)
  if (hit === undefined || hit.value.length === 0) return undefined
  return detectDeepSeekCurrency(hit.value, fetchFn)
}
