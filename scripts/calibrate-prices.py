#!/usr/bin/env python3
"""从供应商自己的账单反解模型单价，输出可粘进配置的 modelPrices。

为什么这样做：官方价目表只覆盖官方线路；网关/中转站的加价、缓存价、写入价往往不同，
而它们的账单里有**逐条请求的真实费用与 token 数**，四个单价可以直接解出来并用残差验证。

原理：把每条记录当作一个方程
    cost = in·Pi + cache_read·Pc + cache_write·Pw + out·Po   （单价为每百万 token）
用最小二乘解 (Pi, Pc, Pw, Po)。若某列 token 总量接近 0，该单价**不可解** ——
脚本会把它标出来，而不是给出一个看似有值的错误答案（实测见过解出 -3.4 的情况）。

两种模式：

1. **反解**（默认）：从账单解出能解的单价，并标出欠定（token 太少）的那些。
2. **验证**（`--verify`）：给定一组候选单价，逐条检查是否与账单**精确一致**。
   欠定的单价应从官方价目或供应商文档取候选值，再用这个模式确认 —— 实测见过
   某模型 200 条记录的每条都与候选值吻合到 6 位小数（比值 1.000），
   而单靠反解会因为该列 token 近乎为零而给出 -3.42 这种错值。

用法：
    python3 scripts/calibrate-prices.py [--base http://127.0.0.1:3425] [--agent dsh] [--model M]
    python3 scripts/calibrate-prices.py --verify --model claude-haiku-5-5 \
        --rates in=0.5,cache_read=0.05,cache_write=0.625,out=2.5

鉴权：从环境变量 MAGPIE_GATEWAY_KEY 读取（也可用 --key）。
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import subprocess
import sys

import numpy as np

FIELDS = ('in', 'cache_read', 'cache_write', 'out')
LABELS = ('inputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion')
# 某列 token 总量低于它全部记录总量的这个比例时，认为该单价不可解。
MIN_SHARE = 0.01


def fetch_rows(base: str, key: str, agent: str | None, model: str | None, pages: int = 6, limit: int = 200) -> list[dict]:
    """按页拉取计费明细。"""
    rows: list[dict] = []
    for page in range(pages):
        query = f"limit={limit}&offset={page * limit}"
        if agent:
            query += f"&agent={agent}"
        if model:
            query += f"&model={model}"
        url = f"{base}/v1/magpie/usage/requests?{query}"
        raw = subprocess.run(
            ['curl', '-s', '--max-time', '25', url, '-H', f'Authorization: Bearer {key}'],
            capture_output=True, text=True,
        ).stdout
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            break
        batch = payload.get('rows') or []
        rows += [r for r in batch if isinstance(r, dict)]
        if len(batch) < limit:
            break
    return rows


def solve(rows: list[dict]) -> dict | None:
    """解出四个单价；返回 None 表示样本不足。"""
    priced = [r for r in rows if r.get('priced') and (r.get('cost') or 0) > 0]
    if len(priced) < 5:
        return None
    matrix = np.array([[(r.get(f) or 0) / 1e6 for f in FIELDS] for r in priced])
    cost = np.array([r['cost'] for r in priced])
    totals = matrix.sum(axis=0)
    grand = totals.sum()
    usable = [i for i in range(4) if grand > 0 and totals[i] / grand >= MIN_SHARE]
    if not usable:
        return None
    solution, *_ = np.linalg.lstsq(matrix[:, usable], cost, rcond=None)
    residual = float(np.abs(matrix[:, usable] @ solution - cost).max())
    return {
        'rows': len(priced),
        'rates': {LABELS[i]: float(solution[k]) for k, i in enumerate(usable)},
        'undetermined': [LABELS[i] for i in range(4) if i not in usable],
        'residual': residual,
        'total': float(cost.sum()),
        'exact': residual < 1e-9,
    }


def describe(name: str, result: dict) -> str:
    rates = '  '.join(f'{k.split("PerMillion")[0]}={v:g}' for k, v in result['rates'].items())
    verdict = '精确' if result['exact'] else f'残差 {result["residual"]:.2e}'
    missing = f' · 不可解: {", ".join(result["undetermined"])}' if result['undetermined'] else ''
    return f'{name:<28} {result["rows"]:>5} 条  {verdict:<16} {rates}{missing}'


def verify(rows: list[dict], rates: dict[str, float]) -> None:
    """逐条核对候选单价与账单是否精确一致。"""
    priced = [r for r in rows if r.get('priced') and (r.get('cost') or 0) > 0]
    if not priced:
        sys.exit('没有可比对的计费记录。')
    worst = 0.0
    worst_row = None
    total = 0.0
    for row in priced:
        predicted = sum((row.get(field) or 0) * rates[field] for field in FIELDS) / 1e6
        delta = abs(predicted - row['cost'])
        total += row['cost']
        if delta > worst:
            worst, worst_row = delta, row
    verdict = '精确一致（每条都吻合）' if worst < 1e-9 else f'最大偏差 {worst:.3e}'
    print(f'  核对 {len(priced)} 条记录 · 合计 ${total:.4f} · {verdict}')
    if worst >= 1e-9 and worst_row is not None:
        predicted = sum((worst_row.get(f) or 0) * rates[f] for f in FIELDS) / 1e6
        print(f'  偏差最大的一条: {worst_row.get("t")}  账单 {worst_row["cost"]:.8f}  按候选价 {predicted:.8f}')
        print(f'    tokens: ' + ' '.join(f'{f}={worst_row.get(f) or 0}' for f in FIELDS))
        print('  → 候选价与账单不符。该模型可能分档计价或有最低收费，按分组再试。')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://127.0.0.1:3425')
    parser.add_argument('--key', default=os.environ.get('MAGPIE_GATEWAY_KEY', 'magpie'))
    parser.add_argument('--agent', default=None, help='只看某个调用方（例如 dsh）')
    parser.add_argument('--model', default=None)
    parser.add_argument('--verify', action='store_true', help='逐条核对候选单价，而不是反解')
    parser.add_argument('--rates', default=None, help='候选单价，形如 in=0.5,cache_read=0.05,cache_write=0.625,out=2.5')
    args = parser.parse_args()

    if args.verify or args.rates:
        if not args.model or not args.rates:
            sys.exit('验证模式需要 --model 与 --rates。')
        rates: dict[str, float] = {}
        for part in args.rates.split(','):
            name, _, value = part.partition('=')
            key = name.strip()
            if key not in FIELDS:
                sys.exit(f'未知的单价字段 {key}；可用: {", ".join(FIELDS)}')
            rates[key] = float(value)
        for field in FIELDS:
            rates.setdefault(field, 0.0)
        rows = fetch_rows(args.base, args.key, args.agent, args.model)
        verify(rows, rates)
        return

    rows = fetch_rows(args.base, args.key, args.agent, args.model)
    if not rows:
        sys.exit('没取到计费明细：确认网关地址、key，以及它是否提供 usage/requests 接口。')
    priced = [r for r in rows if r.get('priced') and (r.get('cost') or 0) > 0]
    print(f'明细 {len(rows)} 条，其中有价 {len(priced)} 条'
          + (f'（agent={args.agent}）' if args.agent else ''))

    by_model: dict[str, list[dict]] = collections.defaultdict(list)
    for row in priced:
        by_model[str(row.get('model'))].append(row)

    print('\n候选解（每个模型都试几种分组，挑拟合最好的）：')
    chosen: dict[str, dict] = {}
    for model, group in sorted(by_model.items(), key=lambda kv: -len(kv[1])):
        candidates: list[tuple[str, dict]] = []
        overall = solve(group)
        if overall:
            candidates.append(('全部', overall))
        for field in ('tier_served', 'ep'):
            buckets: dict[str, list[dict]] = collections.defaultdict(list)
            for row in group:
                buckets[str(row.get(field))].append(row)
            for value, subgroup in buckets.items():
                if value in ('None', '') or len(subgroup) < 6:
                    continue
                result = solve(subgroup)
                if result:
                    candidates.append((f'{field}={value}', result))
        if not candidates:
            continue
        exact = [c for c in candidates if c[1]['exact'] and not c[1]['undetermined']]
        best = (exact or candidates)[0]
        for label, result in candidates:
            print('  ' + describe(f'{model} [{label}]', result))
        chosen[model] = {**best[1], 'source': best[0]}

    if not chosen:
        sys.exit('\n没有可解的模型。')

    print('\n推荐写入配置的单价（挑精确且四个都能解的那组）：')
    print('\nmodelPrices:')
    for model, result in chosen.items():
        print(f'  - model: {model}')
        print('    currency: USD')
        for label in LABELS:
            value = result['rates'].get(label)
            print(f'    {label}: {value:g}' if value is not None
                  else f'    # {label}: 不可解（该列的 token 太少），需另找样本或按官方价填')
        note = '精确拟合' if result['exact'] else f'残差 {result["residual"]:.2e}'
        print(f'    # 来源: 账单 {result["rows"]} 条（分组 {result["source"]}）· {note} · 合计 ${result["total"]:.4f}')


if __name__ == '__main__':
    main()
