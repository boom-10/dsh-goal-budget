#!/usr/bin/env python3
"""重新生成 src/holiday-calendar.ts（中国法定节假日放假日，来源 holiday-cn）。

用法：
    python3 scripts/build-holidays.py 2025 2026 2027

数据来自 NateScarlet/holiday-cn 的固定版本（下面的 COMMIT）。
- 每年更新：上游发布新年度的放假安排后，把新年份加进参数即可；COVERED_YEARS 会同步更新。
- 换版本：改 COMMIT，并同步替换 THIRD_PARTY/holiday-cn-LICENSE（上游的 MIT 许可证）。
"""
import json
import pathlib
import sys
import urllib.request

COMMIT = 'dcecbce230a57639cc8967ec9e2465e744880fd8'
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'holiday-calendar.ts'


def off_days(year: int) -> list[str]:
    url = f'https://raw.githubusercontent.com/NateScarlet/holiday-cn/{COMMIT}/{year}.json'
    with urllib.request.urlopen(url, timeout=60) as response:
        data = json.load(response)
    if data.get('year') != year:
        raise SystemExit(f'上游年份不符：请求 {year}，返回 {data.get("year")}')
    return sorted(day['date'] for day in data['days'] if day.get('isOffDay'))


def main() -> None:
    years = sorted({int(arg) for arg in sys.argv[1:]}) or [2025, 2026]
    dates: list[str] = []
    for year in years:
        dates += off_days(year)
    lines = [
        '/**',
        ' * 中国法定节假日放假日，来源 holiday-cn（NateScarlet/holiday-cn，MIT 许可，见 THIRD_PARTY/holiday-cn-LICENSE）。',
        f' * 固定版本：{COMMIT}。',
        ' * 只列放假日。补班日都在周末，周末本来就是空闲时段，不需要列出。',
        ' * 每年更新：运行 scripts/build-holidays.py 重新生成本文件。',
        ' */',
        '',
        f"export const HOLIDAY_SOURCE = 'holiday-cn@{COMMIT}'",
        f"export const COVERED_YEARS: readonly number[] = [{', '.join(str(y) for y in years)}]",
        'export const OFF_DAYS: readonly string[] = [',
        *[f"  '{d}'," for d in dates],
        ']',
    ]
    OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'写入 {OUT.relative_to(ROOT)}：{len(years)} 个年度，{len(dates)} 个放假日')


if __name__ == '__main__':
    main()
