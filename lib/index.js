// src/index.ts
import z2 from "@deepseek-ai/schemastery";

// src/accounting.ts
function costOf(usage, p) {
  const M = 1e6;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (usage.inputTokens + cacheWrite) / M * p.inputPerMillion + cacheRead / M * p.cacheReadPerMillion + usage.outputTokens / M * p.outputPerMillion;
}
function billedTokensOf(usage) {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
}
var UNPRICED = { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 };
function openRound(prev, at) {
  if (prev.startedAt !== void 0) {
    return prev.endedAt !== void 0 && prev.endedAt >= at ? prev : { ...prev, endedAt: at };
  }
  return { ...prev, startedAt: at, endedAt: at };
}
function addUsage(prev, usage, p, at) {
  const end = at === void 0 ? prev.endedAt : Math.max(prev.endedAt ?? at, at);
  if (usage === void 0) {
    return { ...prev, attributable: false, endedAt: end };
  }
  return {
    turn: prev.turn,
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: prev.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: prev.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: prev.costUsd + costOf(usage, p),
    attributable: true,
    // 时间字段必须显式带过去：上面是逐字段构造，漏掉 startedAt 会让整轮的
    // 时长被 totalsOf 当作「未开始」而丢掉（这正是 wallclock.spec 抓到的 bug）。
    startedAt: prev.startedAt,
    endedAt: end
  };
}
function totalsOf(spend) {
  let tokens = 0;
  let costUsd = 0;
  let wallClockMs = 0;
  for (const t of spend.rounds.values()) {
    tokens += t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
    costUsd += t.costUsd;
    if (t.startedAt !== void 0 && t.endedAt !== void 0) {
      wallClockMs += Math.max(0, t.endedAt - t.startedAt);
    }
  }
  return { tokens, costUsd, rounds: spend.rounds.size, wallClockMs };
}
function checkBudget(spend, budget) {
  const t = totalsOf(spend);
  const ratios = [];
  if (budget.tokens && budget.tokens > 0) {
    ratios.push({ kind: "tokens", ratio: t.tokens / budget.tokens, limit: budget.tokens, used: t.tokens });
  }
  if (budget.costUsd && budget.costUsd > 0) {
    ratios.push({ kind: "costUsd", ratio: t.costUsd / budget.costUsd, limit: budget.costUsd, used: t.costUsd });
  }
  if (budget.wallClockMs && budget.wallClockMs > 0) {
    ratios.push({
      kind: "wallClockMs",
      ratio: t.wallClockMs / budget.wallClockMs,
      limit: budget.wallClockMs,
      used: t.wallClockMs
    });
  }
  if (ratios.length === 0) return { exceeded: false, ratio: 0 };
  const worst = ratios.reduce((a, b) => b.ratio > a.ratio ? b : a);
  return worst.ratio >= 1 ? { exceeded: true, ratio: worst.ratio, kind: worst.kind, limit: worst.limit, used: worst.used } : { exceeded: false, ratio: worst.ratio };
}

// src/currency-detect.ts
var DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
async function detectDeepSeekCurrency(apiKey, fetchFn = fetch) {
  const response = await fetchFn(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(1e4)
  });
  if (!response.ok) throw new Error(`DeepSeek \u4F59\u989D\u63A5\u53E3\u8FD4\u56DE HTTP ${response.status}`);
  const body = await response.json();
  const codes = new Set(
    (body.balance_infos ?? []).map((info) => info.currency).filter((c) => typeof c === "string")
  );
  if (codes.size !== 1) return void 0;
  const [code] = [...codes];
  return code === "CNY" || code === "USD" ? code : void 0;
}
async function detectAccountCurrency(creds, ref, fetchFn) {
  if (creds === void 0) return void 0;
  const hit = await creds.resolve(ref);
  if (hit === void 0 || hit.value.length === 0) return void 0;
  return detectDeepSeekCurrency(hit.value, fetchFn);
}

// src/holiday-calendar.ts
var COVERED_YEARS = [2025, 2026];
var OFF_DAYS = [
  "2025-01-01",
  "2025-01-28",
  "2025-01-29",
  "2025-01-30",
  "2025-01-31",
  "2025-02-01",
  "2025-02-02",
  "2025-02-03",
  "2025-02-04",
  "2025-04-04",
  "2025-04-05",
  "2025-04-06",
  "2025-05-01",
  "2025-05-02",
  "2025-05-03",
  "2025-05-04",
  "2025-05-05",
  "2025-05-31",
  "2025-06-01",
  "2025-06-02",
  "2025-10-01",
  "2025-10-02",
  "2025-10-03",
  "2025-10-04",
  "2025-10-05",
  "2025-10-06",
  "2025-10-07",
  "2025-10-08",
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07"
];

// src/tariff.ts
var DEEPSEEK_TARIFFS = {
  USD: {
    "deepseek-flash": {
      offPeak: { cacheHit: 3e-3, cacheMiss: 0.15, output: 0.6 },
      peak: { cacheHit: 6e-3, cacheMiss: 0.3, output: 1.2 }
    },
    "deepseek-v4-pro": {
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }
    }
  },
  CNY: {
    "deepseek-flash": {
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
    },
    "deepseek-v4-pro": {
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 }
    }
  }
};
var BUILTIN_ALIASES = {
  "deepseek-flash": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4.1-flash-vision-exp": "deepseek-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4.1-pro": "deepseek-v4-pro"
};
var SEPARATORS = ["/", "--", ":"];
function lastSegment(id) {
  let end = -1;
  for (const sep of SEPARATORS) {
    const at = id.lastIndexOf(sep);
    if (at !== -1) end = Math.max(end, at + sep.length - 1);
  }
  return end === -1 ? id : id.slice(end + 1);
}
function canonicalDeepSeekModel(id, aliases = {}) {
  if (id === void 0 || id.length === 0) return void 0;
  for (const name2 of [id, lastSegment(id)]) {
    for (const key of name2 === name2.toLowerCase() ? [name2] : [name2, name2.toLowerCase()]) {
      if (Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
      if (Object.prototype.hasOwnProperty.call(BUILTIN_ALIASES, key)) return BUILTIN_ALIASES[key];
    }
  }
  return void 0;
}
var BEIJING_OFFSET_MS = 8 * 36e5;
var OFF_DAY_SET = new Set(OFF_DAYS);
function beijingClock(at) {
  const bj = new Date(at + BEIJING_OFFSET_MS);
  return {
    weekday: bj.getUTCDay(),
    date: bj.toISOString().slice(0, 10),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    year: bj.getUTCFullYear()
  };
}
function bandAt(at) {
  const c = beijingClock(at);
  if (c.weekday === 0 || c.weekday === 6) return "offPeak";
  if (OFF_DAY_SET.has(c.date)) return "offPeak";
  const inPeak = c.minutes >= 540 && c.minutes < 720 || c.minutes >= 840 && c.minutes < 1080;
  return inPeak ? "peak" : "offPeak";
}
function bandFor(at, peakPricing) {
  return peakPricing ? bandAt(at) : "offPeak";
}
function calendarCovers(at) {
  return COVERED_YEARS.includes(beijingClock(at).year);
}
function ratesFor(model, currency, band) {
  return DEEPSEEK_TARIFFS[currency][model][band];
}
function costOfTariff(u, r) {
  return ((u.inputTokens + u.cacheWriteTokens) * r.cacheMiss + u.cacheReadTokens * r.cacheHit + u.outputTokens * r.output) / 1e6;
}
function digestOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 1e6;
}

// src/budget-command.ts
function isUnlimited(b) {
  return b.tokens <= 0 && b.costUsd <= 0 && b.wallClockMs <= 0;
}
var MINUTE = 6e4;
var HOUR = 36e5;
var DURATION_UNITS = {
  s: 1e3,
  sec: 1e3,
  secs: 1e3,
  second: 1e3,
  seconds: 1e3,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR
};
function formatDuration(ms) {
  if (ms <= 0) return "0";
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}min`;
  if (ms % 1e3 === 0) return `${ms / 1e3}s`;
  return `${(ms / MINUTE).toFixed(1)}min`;
}
function parseAmount(raw) {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return void 0;
  const usd = /^\$(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\$$/.exec(text);
  if (usd) {
    const value = Number(usd[1] ?? usd[2]);
    return Number.isFinite(value) && value > 0 ? { kind: "costUsd", value, currency: "USD" } : void 0;
  }
  const cny = /^(?:¥|cny)(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)(?:¥|元|cny)$/.exec(text);
  if (cny) {
    const value = Number(cny[1] ?? cny[2]);
    return Number.isFinite(value) && value > 0 ? { kind: "costUsd", value, currency: "CNY" } : void 0;
  }
  const dur = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(text);
  if (dur) {
    const unit = DURATION_UNITS[dur[2]];
    if (unit !== void 0) {
      const base = Number(dur[1]);
      if (!Number.isFinite(base) || base <= 0) return void 0;
      return { kind: "wallClockMs", value: Math.round(base * unit) };
    }
  }
  const tok = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (tok) {
    const base = Number(tok[1]);
    if (!Number.isFinite(base) || base <= 0) return void 0;
    const mult = tok[2] === "k" ? 1e3 : tok[2] === "m" ? 1e6 : 1;
    return { kind: "tokens", value: Math.round(base * mult) };
  }
  return void 0;
}
function parseBudgetCommand(rawInput) {
  const input = rawInput.trim();
  if (input.length === 0) return { kind: "show" };
  const lower = input.toLowerCase();
  if (lower === "off" || lower === "reset" || lower === "none" || lower === "clear") {
    return { kind: "clear" };
  }
  const words = input.split(/\s+/).filter((w) => w.length > 0);
  let tokens = 0;
  let costUsd = 0;
  let costCurrency;
  let wallClockMs = 0;
  const labels = [];
  for (const word of words) {
    const parsed = parseAmount(word);
    if (parsed === void 0) {
      return {
        kind: "invalid",
        reason: `\u65E0\u6CD5\u7406\u89E3\u7684\u989D\u5EA6 "${word}"\u3002\u7528\u6CD5\uFF1A/budget $5 \xB7 /budget 500k \xB7 /budget 30min \xB7 /budget off`
      };
    }
    switch (parsed.kind) {
      case "costUsd":
        if (costUsd > 0) return { kind: "invalid", reason: "\u91D1\u989D\u53EA\u80FD\u5199\u4E00\u6B21\u3002" };
        costUsd = parsed.value;
        costCurrency = parsed.currency ?? "USD";
        labels.push(`${costCurrency === "CNY" ? "\xA5" : "$"}${parsed.value}`);
        break;
      case "tokens":
        if (tokens > 0) return { kind: "invalid", reason: "token \u6570\u53EA\u80FD\u5199\u4E00\u6B21\u3002" };
        tokens = parsed.value;
        labels.push(`${formatTokens(parsed.value)} tokens`);
        break;
      case "wallClockMs":
        if (wallClockMs > 0) return { kind: "invalid", reason: "\u65F6\u957F\u53EA\u80FD\u5199\u4E00\u6B21\u3002" };
        wallClockMs = parsed.value;
        labels.push(formatDuration(parsed.value));
        break;
    }
  }
  if (tokens === 0 && costUsd === 0 && wallClockMs === 0) {
    return { kind: "invalid", reason: "\u81F3\u5C11\u8981\u7ED9\u4E00\u4E2A\u4E0A\u9650\u3002" };
  }
  return {
    kind: "set",
    budget: { tokens, costUsd, wallClockMs, ...costCurrency === void 0 ? {} : { costCurrency } },
    label: labels.join(" + ")
  };
}
function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return String(n);
}
function formatMoney(n, currency = "USD") {
  const symbol = currency === "CNY" ? "\xA5" : "$";
  if (n === 0) return `${symbol}0`;
  return n < 0.01 ? `${symbol}${n.toFixed(4)}` : `${symbol}${n.toFixed(n < 1 ? 3 : 2)}`;
}
function describeBudget(b) {
  if (isUnlimited(b)) return "\u65E0\u9650\u5236";
  const parts = [];
  if (b.tokens > 0) parts.push(`${formatTokens(b.tokens)} tokens`);
  if (b.costUsd > 0) parts.push(formatMoney(b.costUsd, b.costCurrency ?? "USD"));
  if (b.wallClockMs > 0) parts.push(formatDuration(b.wallClockMs));
  return parts.join(" \u6216 ");
}
function renderBudget(effective, source, used) {
  const lines = [];
  const cur = effective.costCurrency ?? "USD";
  lines.push(`\u9884\u7B97\uFF1A${describeBudget(effective)}`);
  lines.push(source === "session" ? "\u6765\u6E90\uFF1A\u672C\u4F1A\u8BDD\u8BBE\u7F6E" : "\u6765\u6E90\uFF1Aprofile \u9ED8\u8BA4");
  if (used !== void 0 && !isUnlimited(effective)) {
    const ratios = [];
    if (effective.tokens > 0) {
      const pct = (used.tokens / effective.tokens * 100).toFixed(0);
      ratios.push(`token ${formatTokens(used.tokens)} / ${formatTokens(effective.tokens)}\uFF08${pct}%\uFF09`);
    }
    if (effective.costUsd > 0) {
      const pct = (used.costUsd / effective.costUsd * 100).toFixed(0);
      ratios.push(`\u8D39\u7528 ${formatMoney(used.costUsd, cur)} / ${formatMoney(effective.costUsd, cur)}\uFF08${pct}%\uFF09`);
    }
    if (effective.wallClockMs > 0) {
      const pct = (used.wallClockMs / effective.wallClockMs * 100).toFixed(0);
      ratios.push(`\u65F6\u95F4 ${formatDuration(used.wallClockMs)} / ${formatDuration(effective.wallClockMs)}\uFF08${pct}%\uFF09`);
    }
    if (ratios.length > 0) lines.push(`\u5DF2\u7528\uFF1A${ratios.join(" \xB7 ")}`);
  } else if (used !== void 0) {
    lines.push(
      `\u5DF2\u7528\uFF1A${formatTokens(used.tokens)} tokens \xB7 ${formatMoney(used.costUsd, cur)} \xB7 ${formatDuration(used.wallClockMs)}`
    );
  }
  lines.push("\u7528\u6CD5\uFF1A/budget $5 \xB7 /budget 500k \xB7 /budget 30min \xB7 /budget off");
  return lines.join("\n");
}

// src/budget-projection.ts
import { z } from "zod";
var currencySchema = z.enum(["USD", "CNY"]);
var budgetSchema = z.object({
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  costCurrency: z.nullable(currencySchema)
}).strict();
var bucketSchema = z.object({
  model: z.enum(["deepseek-flash", "deepseek-v4-pro"]),
  band: z.enum(["peak", "offPeak"]),
  uncached: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative()
}).strict();
var routeSchema = z.object({ provider: z.string().optional(), model: z.string().optional() }).strict();
var stateSchema = z.object({
  budget: z.nullable(budgetSchema),
  route: z.nullable(routeSchema),
  tokens: z.number().nonnegative(),
  unbilledTurns: z.number().int().nonnegative(),
  unpricedModels: z.array(z.string()),
  buckets: z.array(bucketSchema)
}).strict();
var viewSchema = z.object({
  budget: z.nullable(budgetSchema),
  spent: z.object({
    tokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    currency: z.nullable(currencySchema),
    unbilledTurns: z.number().int().nonnegative(),
    unpricedModels: z.array(z.string())
  }).strict()
}).strict();
var EMPTY = { budget: null, route: null, tokens: 0, unbilledTurns: 0, unpricedModels: [], buckets: [] };
function addUnpriced(list, key) {
  return list.includes(key) ? list : [...list, key].sort();
}
function routeKey(route) {
  return `${route?.provider ?? "unknown-provider"}/${route?.model ?? "unknown-model"}`;
}
var bucketKey = (b) => `${b.model}|${b.band}`;
function addToBucket(buckets, add) {
  const key = bucketKey(add);
  if (!buckets.some((b) => bucketKey(b) === key)) {
    return [...buckets, add].sort((a, b) => bucketKey(a) < bucketKey(b) ? -1 : bucketKey(a) > bucketKey(b) ? 1 : 0);
  }
  return buckets.map((b) => bucketKey(b) === key ? {
    model: b.model,
    band: b.band,
    uncached: b.uncached + add.uncached,
    cacheRead: b.cacheRead + add.cacheRead,
    cacheWrite: b.cacheWrite + add.cacheWrite,
    output: b.output + add.output
  } : b);
}
function viewOf(state, currency) {
  let costUsd = 0;
  if (currency !== void 0) {
    for (const b of state.buckets) {
      costUsd += costOfTariff(
        { inputTokens: b.uncached, cacheReadTokens: b.cacheRead, cacheWriteTokens: b.cacheWrite, outputTokens: b.output },
        ratesFor(b.model, currency, b.band)
      );
    }
  }
  return {
    budget: state.budget,
    spent: {
      tokens: state.tokens,
      costUsd,
      currency: currency ?? null,
      unbilledTurns: state.unbilledTurns,
      unpricedModels: [...state.unpricedModels]
    }
  };
}
function createGoalBudgetProjection(options = {}) {
  const getCurrency = options.currency ?? (() => void 0);
  const aliases = options.aliases ?? {};
  const peakPricing = options.peakPricing ?? true;
  return {
    key: "goalBudget",
    stateSchema,
    init() {
      return EMPTY;
    },
    /**
     * 只关心四类事件；其余**必须返回同一个引用**（框架要求，否则触发下游重算）。
     */
    apply(state, event) {
      const data = event?.data;
      if (event?.type === "request/header") {
        const cfg = data?.["header"]?.config;
        const provider = typeof cfg?.provider === "string" ? cfg.provider : void 0;
        const model = typeof cfg?.model === "string" ? cfg.model : void 0;
        if (state.route?.provider === provider && state.route?.model === model) return state;
        return { ...state, route: { provider, model } };
      }
      if (event?.type === "command/run") {
        if (data?.["name"] !== "budget") return state;
        const parsed = parseBudgetCommand(typeof data["args"] === "string" ? data["args"] : "");
        switch (parsed.kind) {
          case "set":
            return {
              ...state,
              budget: { tokens: parsed.budget.tokens, costUsd: parsed.budget.costUsd, costCurrency: parsed.budget.costCurrency ?? null }
            };
          case "clear":
            return state.budget === null ? state : { ...state, budget: null };
          default:
            return state;
        }
      }
      if (event?.type === "assistant/message") {
        const usage = data?.["usage"];
        if (usage === void 0) {
          return { ...state, unbilledTurns: state.unbilledTurns + 1 };
        }
        const tokens = state.tokens + billedTokensOf(usage);
        const model = canonicalDeepSeekModel(state.route?.model, aliases);
        if (model === void 0) {
          return { ...state, tokens, unpricedModels: addUnpriced(state.unpricedModels, routeKey(state.route)) };
        }
        return {
          ...state,
          tokens,
          buckets: addToBucket(state.buckets, {
            model,
            band: bandFor(event.time ?? 0, peakPricing),
            uncached: usage.inputTokens,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
            output: usage.outputTokens
          })
        };
      }
      return state;
    },
    /** 客户端视图：金额按当前币种计算，路由与桶不送出。 */
    wire: {
      viewSchema,
      view: (state) => viewOf(state, getCurrency())
    },
    /** 官方日历的内容参与版本号：日历变了，持久化的旧状态（峰谷已按旧日历分桶）必须重建。 */
    stateVersion: 6e6 + digestOf(OFF_DAYS.join(","))
  };
}

// src/index.ts
var name = "dsh-goal-budget";
var inject = ["commands", "goals", "sessions", "sessionProjections", "agents"];
var Config = z2.object({
  budget: z2.object({
    /** 累计 token 上限（输入含缓存命中，加输出：与宿主「用量」口径一致）。0 = 不限制。 */
    tokens: z2.number().default(0),
    /** 累计费用上限，单位为账户币种（见 currency）。0 = 不限制。 */
    costUsd: z2.number().default(0),
    /** 累计计算时间上限（毫秒）：各轮跨度之和，不含轮与轮之间的空闲。0 = 不限制。 */
    wallClockMs: z2.number().default(0)
  }).default({ tokens: 0, costUsd: 0, wallClockMs: 0 }),
  /**
   * 账户币种。`auto` 用 DeepSeek 余额接口识别（只对官方线路有效）；网关线路请直接指定 USD 或 CNY。
   * 价目是 DeepSeek 官方的，按这个币种选用：美元账户用美元价，人民币账户用人民币价。
   */
  currency: z2.union([z2.const("auto"), z2.const("USD"), z2.const("CNY")]).default("auto"),
  /** 凭据服务里 DeepSeek API Key 的引用名（与 DeepSeek 路由使用的名字一致）。 */
  deepseekCredentialRef: z2.string().default("DEEPSEEK_API_KEY"),
  /**
   * 模型别名：日志里的模型名 → 计价模型。网关给模型加前缀或改名时用。
   * 例：`cm-ais/deepseek-v5-flash: deepseek-flash`。
   * 插件已内置官方名、官方旧名，以及「去掉 `供应商/` 前缀」的匹配，多数网关无需配置。
   */
  modelAliases: z2.dict(z2.union([z2.const("deepseek-flash"), z2.const("deepseek-v4-pro")])).default({}),
  /**
   * 是否按 DeepSeek 官方的峰谷时段计价（北京时间周一至周五 9–12、14–18 为高峰，单价 2 倍）。
   *
   * 官方线路为 true。**网关线路通常为 false**：实测某网关 197 条 deepseek 记录全部落在高峰时段，
   * 收费却与非高峰价逐条精确吻合（见 README「用网关账单校准」）。设错会让高峰时段高估一倍。
   */
  peakPricing: z2.boolean().default(true),
  /** 超预算时的动作。`block` 会调 ctx.goals.block() 并自动 disarm。 */
  onExceed: z2.union([z2.const("block"), z2.const("warn")]).default("block"),
  /** 达到该比例时注入一次提醒（0–1）。0 = 不提醒。 */
  warnAtRatio: z2.number().default(0.8)
});
var ledgers = /* @__PURE__ */ new WeakMap();
var ownershipBySession = /* @__PURE__ */ new WeakMap();
var routeBySession = /* @__PURE__ */ new WeakMap();
function ledgerFor(agent) {
  let l = ledgers.get(agent);
  if (!l) {
    l = { byGoal: /* @__PURE__ */ new Map(), warned: /* @__PURE__ */ new Set(), blocked: /* @__PURE__ */ new Set() };
    ledgers.set(agent, l);
  }
  return l;
}
function spendFor(l, goalId) {
  let s = l.byGoal.get(goalId);
  if (!s) {
    s = { goalId, rounds: /* @__PURE__ */ new Map(), unattributableTurns: 0 };
    l.byGoal.set(goalId, s);
  }
  return s;
}
var emptyTurn = (turn) => ({
  turn,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  attributable: true
});
function apply(ctx, config) {
  const profileBudget = {
    tokens: config.budget?.tokens ?? 0,
    costUsd: config.budget?.costUsd ?? 0,
    wallClockMs: config.budget?.wallClockMs ?? 0
  };
  const sessionOverrides = /* @__PURE__ */ new WeakMap();
  const resolveBudget = (agent) => {
    const override = sessionOverrides.get(agent);
    return override === void 0 ? { budget: profileBudget, source: "profile" } : { budget: override, source: "session" };
  };
  let currency = config.currency === "auto" ? void 0 : config.currency;
  if (config.currency === "auto") {
    void detectAccountCurrency(ctx.get?.("credentials"), config.deepseekCredentialRef).then(
      (detected) => {
        if (detected === void 0) {
          ctx.logger.warn("[goal-budget] \u6CA1\u80FD\u4ECE DeepSeek \u4F59\u989D\u63A5\u53E3\u8BC6\u522B\u8D26\u6237\u5E01\u79CD\uFF0C\u8D39\u7528\u6682\u4E0D\u8BA1\u5165\uFF1B\u8BF7\u5728\u914D\u7F6E\u91CC\u8BBE\u7F6E currency\uFF08USD \u6216 CNY\uFF09");
          return;
        }
        currency = detected;
        console.log(`[goal-budget] DeepSeek \u8D26\u6237\u5E01\u79CD\uFF1A${detected}`);
      },
      (error) => {
        ctx.logger.warn(`[goal-budget] \u5E01\u79CD\u8BC6\u522B\u5931\u8D25\uFF0C\u8D39\u7528\u6682\u4E0D\u8BA1\u5165\uFF1A${String(error)}`);
      }
    );
  }
  if (!calendarCovers(Date.now())) {
    ctx.logger.warn("[goal-budget] \u8282\u5047\u65E5\u65E5\u5386\u4E0D\u8986\u76D6\u5F53\u524D\u5E74\u4EFD\uFF0C\u5047\u671F\u7684\u5CF0\u8C37\u5224\u65AD\u4E0D\u51C6\u786E\uFF1B\u8BF7\u8FD0\u884C scripts/build-holidays.py \u66F4\u65B0");
  }
  const unlimited = isUnlimited(profileBudget);
  let projection;
  void Promise.resolve(ctx.sessionProjections.register(createGoalBudgetProjection({ currency: () => currency, aliases: config.modelAliases, peakPricing: config.peakPricing }))).then(
    (handle) => {
      projection = handle;
    },
    // register 可能是异步的；失败不能拖垮插件加载（postmortem 0001 的教训：
    // 加载期的异常会让整个 fiber 失败）。
    (error) => {
      ctx.logger.warn(`[goal-budget] goalBudget \u6295\u5F71\u6CE8\u518C\u5931\u8D25\uFF0C\u5BA2\u6237\u7AEF\u5C06\u8BFB\u4E0D\u5230\u9884\u7B97\uFF1A${String(error)}`);
    }
  );
  const routeOf = (session) => {
    const seen = routeBySession.get(session);
    if (seen !== void 0) return seen;
    const fromLog = projection?.stateOf?.(session)?.route;
    if (fromLog === void 0 || fromLog === null) return void 0;
    routeBySession.set(session, fromLog);
    return fromLog;
  };
  console.log(
    `[goal-budget] \u5DF2\u52A0\u8F7D \xB7 inject=[${inject.join(",")}] \xB7 ` + (unlimited ? "profile \u672A\u8BBE\u9ED8\u8BA4\u9884\u7B97 \u2014\u2014 \u7528 /budget \u6309\u4F1A\u8BDD\u8BBE\u7F6E\uFF0C\u6216\u5728 cordis.patch.yml \u91CC\u914D budget" : `\u9ED8\u8BA4\u9884\u7B97 ${describeBudget(profileBudget)} \xB7 \u8D85\u9650\u52A8\u4F5C=${config.onExceed} \xB7 /budget \u53EF\u6309\u4F1A\u8BDD\u8986\u76D6`)
  );
  ctx.commands.register({
    definitionId: "dsh-goal-budget",
    name: "budget",
    description: "Set or view the resource budget for this session",
    input: { hint: "[<$usd>|<tokens>|off]" },
    handler: (invocation) => {
      const parsed = parseBudgetCommand(invocation.rawInput);
      switch (parsed.kind) {
        case "show": {
          const { budget, source } = resolveBudget(invocation.agent);
          return { kind: "success", text: renderBudget(budget, source, usedFor(invocation.agent)) };
        }
        case "set": {
          if (parsed.budget.costUsd > 0 && parsed.budget.costCurrency !== void 0 && currency !== void 0 && parsed.budget.costCurrency !== currency) {
            const symbol = currency === "CNY" ? "\xA5" : "$";
            return { kind: "error", text: `\u672C\u4F1A\u8BDD\u7684\u8D26\u6237\u5E01\u79CD\u662F ${currency}\uFF0C\u8D39\u7528\u4E0A\u9650\u8BF7\u7528 ${symbol} \u8BBE\u5B9A\uFF08\u4F8B\u5982 /budget ${symbol}${currency === "CNY" ? "30" : "5"}\uFF09\u3002` };
          }
          sessionOverrides.set(invocation.agent, parsed.budget);
          const l = ledgers.get(invocation.agent);
          if (l) l.blocked.clear();
          return {
            kind: "success",
            text: `\u672C\u4F1A\u8BDD\u9884\u7B97\u5DF2\u8BBE\u4E3A ${describeBudget(parsed.budget)}\u3002
\u8D85\u8FC7\u65F6\u4F1A\u963B\u65AD\u5F53\u524D goal \u5E76\u505C\u6B62\u81EA\u52A8\u7EED\u8DD1\u3002\u7528 /budget off \u6062\u590D profile \u9ED8\u8BA4\u3002`
          };
        }
        case "clear": {
          sessionOverrides.delete(invocation.agent);
          const l = ledgers.get(invocation.agent);
          if (l) l.blocked.clear();
          const { budget } = resolveBudget(invocation.agent);
          return {
            kind: "success",
            text: `\u5DF2\u6062\u590D profile \u9ED8\u8BA4\u9884\u7B97\uFF1A${describeBudget(budget)}`
          };
        }
        case "invalid":
          return { kind: "error", text: parsed.reason };
      }
    }
  });
  ctx.on("agent/inbox/claimed", (payload) => {
    const src = payload.message?.source;
    if (src?.kind !== "goal" || typeof src.round !== "number") return;
    if (src.round <= 0) return;
    const session = payload.agent.session;
    if (session === void 0) {
      ctx.logger.warn("[goal-budget] \u8FD9\u6761 goal \u6D88\u606F\u53D6\u4E0D\u5230\u6240\u5C5E\u4F1A\u8BDD\uFF0C\u672C\u8F6E\u7528\u91CF\u4E0D\u4F1A\u8BB0\u8D26");
      return;
    }
    let owners = ownershipBySession.get(session);
    if (owners === void 0) {
      owners = /* @__PURE__ */ new Map();
      ownershipBySession.set(session, owners);
    }
    owners.set(payload.turn, { goalId: String(src.goalId), round: src.round, agent: payload.agent });
    ledgerFor(payload.agent);
  });
  ctx.on("session/event", (session, event) => {
    if (event?.type === "request/header") {
      const cfg = event.data?.header?.config;
      routeBySession.set(session, {
        provider: typeof cfg?.provider === "string" ? cfg.provider : void 0,
        model: typeof cfg?.model === "string" ? cfg.model : void 0
      });
      return;
    }
    const type = event?.type;
    if (type !== "assistant/message" && type !== "turn/start" && type !== "turn/end") return;
    const at = typeof event.time === "number" ? event.time : void 0;
    const data = event.data;
    const turn = data?.turn;
    if (typeof turn !== "number") return;
    const owned = ownershipBySession.get(session)?.get(turn);
    if (owned === void 0) return;
    const l = ledgerFor(owned.agent);
    {
      const own = owned;
      const spend = spendFor(l, own.goalId);
      const prev = spend.rounds.get(own.round) ?? emptyTurn(turn);
      if (type === "turn/start") {
        spend.rounds.set(own.round, at === void 0 ? prev : openRound(prev, at));
        return;
      }
      if (type === "turn/end") {
        spend.rounds.set(own.round, at === void 0 ? prev : { ...prev, endedAt: Math.max(prev.endedAt ?? at, at) });
        return;
      }
      const opened = at === void 0 ? prev : openRound(prev, at);
      const route = routeOf(session);
      const model = canonicalDeepSeekModel(route?.model, config.modelAliases);
      const pricing = model === void 0 || currency === void 0 || at === void 0 ? void 0 : pricingOf(model, currency, bandFor(at, config.peakPricing));
      if (pricing === void 0) spend.unpricedTurns = (spend.unpricedTurns ?? 0) + 1;
      const next = addUsage(opened, data?.usage, pricing ?? UNPRICED, at);
      spend.rounds.set(own.round, next);
      if (!next.attributable) spend.unattributableTurns += 1;
      const { budget: effective } = resolveBudget(own.agent);
      evaluate(ctx, l, own.goalId, own.agent, costInCurrency(effective, currency), config.onExceed, config.warnAtRatio ?? 0);
      return;
    }
  });
}
function costInCurrency(b, currency) {
  if (b.costUsd <= 0 || b.costCurrency === void 0) return b;
  return currency !== void 0 && b.costCurrency === currency ? b : { ...b, costUsd: 0 };
}
function pricingOf(model, currency, band) {
  const r = ratesFor(model, currency, band);
  return { inputPerMillion: r.cacheMiss, outputPerMillion: r.output, cacheReadPerMillion: r.cacheHit };
}
function usedFor(agent) {
  const l = ledgers.get(agent);
  if (!l) return void 0;
  let tokens = 0;
  let costUsd = 0;
  let wallClockMs = 0;
  for (const spend of l.byGoal.values()) {
    const t = totalsOf(spend);
    tokens += t.tokens;
    costUsd += t.costUsd;
    wallClockMs += t.wallClockMs;
  }
  return { tokens, costUsd, wallClockMs };
}
function evaluate(ctx, l, goalId, agent, budget, onExceed, warnAtRatio) {
  const spend = l.byGoal.get(goalId);
  if (!spend) return;
  const verdict = checkBudget(spend, budget);
  const warnAt = warnAtRatio;
  if (warnAt > 0 && !verdict.exceeded && verdict.ratio >= warnAt) {
    const key = `${goalId}:${Math.floor(verdict.ratio * 10) / 10}`;
    if (!l.warned.has(key)) {
      l.warned.add(key);
      ctx.logger.warn(
        `[goal-budget] goal ${goalId} \u5DF2\u7528 ${(verdict.ratio * 100).toFixed(0)}% \u9884\u7B97` + (spend.unattributableTurns > 0 ? `\uFF08\u53E6\u6709 ${spend.unattributableTurns} \u4E2A turn \u65E0\u6CD5\u5F52\u56E0\uFF09` : "")
      );
    }
  }
  if (!verdict.exceeded) return;
  if (l.blocked.has(goalId)) return;
  const usedText = verdict.kind === "wallClockMs" ? formatDuration(verdict.used) : String(verdict.used);
  const limitText = verdict.kind === "wallClockMs" ? formatDuration(verdict.limit) : String(verdict.limit);
  const message = `Goal exceeded its configured ${verdict.kind} budget: ${verdict.kind === "costUsd" ? verdict.used.toFixed(6) : usedText} / ${limitText}` + (spend.unattributableTurns > 0 ? ` (${spend.unattributableTurns} turn(s) reported no usage and are not counted)` : "");
  if (onExceed === "warn") {
    ctx.logger.warn(`[goal-budget] ${message}`);
    l.blocked.add(goalId);
    return;
  }
  const goal = ctx.goals.get(agent);
  if (!goal) {
    ctx.logger.warn(`[goal-budget] \u8D85\u9884\u7B97\u4F46\u8BFB\u4E0D\u5230\u5F53\u524D goal\uFF0C\u65E0\u6CD5\u963B\u65AD\uFF1A${message}`);
    return;
  }
  ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: "budget-exceeded", message });
  l.blocked.add(goalId);
  ctx.logger.warn(`[goal-budget] \u5DF2\u963B\u65AD goal ${goalId}\uFF1A${message}`);
}
export {
  Config,
  apply,
  inject,
  name
};
