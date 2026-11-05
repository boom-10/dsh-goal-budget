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
var DEFAULT_PRICES = [
  { model: "deepseek-flash", inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 3e-3, peakMultiplier: 2, holidays: [] },
  { model: "deepseek-v4-pro", inputPerMillion: 0.66, outputPerMillion: 1.98, cacheReadPerMillion: 0.022, peakMultiplier: 2, holidays: [] }
];
var UNPRICED = { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 };
function findPriceByModel(entries, model) {
  if (model === void 0) return void 0;
  return entries.find((e) => e.model === model);
}
function isPeak(at, holidays) {
  const d = new Date(at);
  const hour = d.getUTCHours();
  if (!(hour >= 1 && hour < 4 || hour >= 6 && hour < 10)) return false;
  const weekday = d.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.includes(d.toISOString().slice(0, 10));
}
function pricingAt(e, at) {
  if (at === void 0 || !isPeak(at, e.holidays)) {
    return { inputPerMillion: e.inputPerMillion, outputPerMillion: e.outputPerMillion, cacheReadPerMillion: e.cacheReadPerMillion };
  }
  const m = e.peakMultiplier;
  return {
    inputPerMillion: e.inputPerMillion * m,
    outputPerMillion: e.outputPerMillion * m,
    cacheReadPerMillion: e.cacheReadPerMillion * m
  };
}
function priceDigest(entries) {
  const text = JSON.stringify(entries);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 1e6;
}
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
    return Number.isFinite(value) && value > 0 ? { kind: "costUsd", value } : void 0;
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
        labels.push(`$${parsed.value}`);
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
  return { kind: "set", budget: { tokens, costUsd, wallClockMs }, label: labels.join(" + ") };
}
function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return String(n);
}
function formatUsd(n) {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
function describeBudget(b) {
  if (isUnlimited(b)) return "\u65E0\u9650\u5236";
  const parts = [];
  if (b.tokens > 0) parts.push(`${formatTokens(b.tokens)} tokens`);
  if (b.costUsd > 0) parts.push(formatUsd(b.costUsd));
  if (b.wallClockMs > 0) parts.push(formatDuration(b.wallClockMs));
  return parts.join(" \u6216 ");
}
function renderBudget(effective, source, used) {
  const lines = [];
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
      ratios.push(`\u8D39\u7528 ${formatUsd(used.costUsd)} / ${formatUsd(effective.costUsd)}\uFF08${pct}%\uFF09`);
    }
    if (effective.wallClockMs > 0) {
      const pct = (used.wallClockMs / effective.wallClockMs * 100).toFixed(0);
      ratios.push(`\u65F6\u95F4 ${formatDuration(used.wallClockMs)} / ${formatDuration(effective.wallClockMs)}\uFF08${pct}%\uFF09`);
    }
    if (ratios.length > 0) lines.push(`\u5DF2\u7528\uFF1A${ratios.join(" \xB7 ")}`);
  } else if (used !== void 0) {
    lines.push(
      `\u5DF2\u7528\uFF1A${formatTokens(used.tokens)} tokens \xB7 ${formatUsd(used.costUsd)} \xB7 ${formatDuration(used.wallClockMs)}`
    );
  }
  lines.push("\u7528\u6CD5\uFF1A/budget $5 \xB7 /budget 500k \xB7 /budget 30min \xB7 /budget off");
  return lines.join("\n");
}

// src/budget-projection.ts
import { z } from "zod";
var budgetSchema = z.object({ tokens: z.number().nonnegative(), costUsd: z.number().nonnegative() }).strict();
var spentSchema = z.object({
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  unbilledTurns: z.number().int().nonnegative(),
  unpricedModels: z.array(z.string())
}).strict();
var viewSchema = z.object({ budget: z.nullable(budgetSchema), spent: spentSchema }).strict();
var routeSchema = z.object({ provider: z.string().optional(), model: z.string().optional() }).strict();
var stateSchema = z.object({
  budget: z.nullable(budgetSchema),
  spent: spentSchema,
  route: z.nullable(routeSchema)
}).strict();
var EMPTY = {
  budget: null,
  spent: { tokens: 0, costUsd: 0, unbilledTurns: 0, unpricedModels: [] },
  route: null
};
function addUnpriced(list, key) {
  return list.includes(key) ? list : [...list, key].sort();
}
function routeKey(route) {
  return `${route?.provider ?? "unknown-provider"}/${route?.model ?? "unknown-model"}`;
}
function createGoalBudgetProjection(prices = DEFAULT_PRICES) {
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
            return { ...state, budget: { tokens: parsed.budget.tokens, costUsd: parsed.budget.costUsd } };
          case "clear":
            return state.budget === null ? state : { ...state, budget: null };
          default:
            return state;
        }
      }
      if (event?.type === "assistant/message") {
        const usage = data?.["usage"];
        const spent = state.spent;
        if (usage === void 0) {
          return { ...state, spent: { ...spent, unbilledTurns: spent.unbilledTurns + 1 } };
        }
        const tokens = spent.tokens + billedTokensOf(usage);
        const entry = findPriceByModel(prices, state.route?.model);
        if (entry === void 0) {
          return {
            ...state,
            spent: { ...spent, tokens, unpricedModels: addUnpriced(spent.unpricedModels, routeKey(state.route)) }
          };
        }
        return {
          ...state,
          spent: { ...spent, tokens, costUsd: spent.costUsd + costOf(usage, pricingAt(entry, event.time)) }
        };
      }
      return state;
    },
    /** 客户端视图：去掉内部路由，其余原样送出。 */
    wire: {
      viewSchema,
      view: (state) => ({ budget: state.budget, spent: state.spent })
    },
    /** 价格表的摘要参与版本号：价格变了，持久化的旧缓存会被丢弃并重算。 */
    stateVersion: 5e6 + priceDigest(prices)
  };
}

// src/index.ts
var name = "dsh-goal-budget";
var inject = ["commands", "goals", "sessions", "sessionProjections", "agents"];
var Config = z2.object({
  budget: z2.object({
    /** 累计 token 上限（输入含缓存命中，加输出：与宿主「用量」口径一致）。0 = 不限制。 */
    tokens: z2.number().default(0),
    /** 累计费用上限（美元，按下面的单价估算）。0 = 不限制。 */
    costUsd: z2.number().default(0),
    /** 累计计算时间上限（毫秒）：各轮跨度之和，不含轮与轮之间的空闲。0 = 不限制。 */
    wallClockMs: z2.number().default(0)
  }).default({ tokens: 0, costUsd: 0, wallClockMs: 0 }),
  /**
   * 价格表，按模型 id 匹配（不区分网关）。留空则使用内置的 DeepSeek 官方价格。
   * 查不到单价的模型：token 照常计入，费用不计，并在面板里列出它的名字。
   */
  prices: z2.array(
    z2.object({
      model: z2.string(),
      inputPerMillion: z2.number(),
      outputPerMillion: z2.number(),
      cacheReadPerMillion: z2.number(),
      /** 高峰价相对非高峰价的倍数。官方 DeepSeek 为 2；网关不分时段就设 1。 */
      peakMultiplier: z2.number().default(2),
      /** `YYYY-MM-DD`：这些日期全天按非高峰计（官方排除中国法定节假日，需要你维护）。 */
      holidays: z2.array(z2.string()).default([])
    })
  ).default([]),
  /** 超预算时的动作。`block` 会调 ctx.goals.block() 并自动 disarm。 */
  onExceed: z2.union([z2.const("block"), z2.const("warn")]).default("block"),
  /** 达到该比例时注入一次提醒（0–1）。0 = 不提醒。 */
  warnAtRatio: z2.number().default(0.8)
});
var ledgers = /* @__PURE__ */ new WeakMap();
var liveLedgers = /* @__PURE__ */ new Set();
var routeBySession = /* @__PURE__ */ new WeakMap();
function ledgerFor(agent) {
  let l = ledgers.get(agent);
  if (!l) {
    l = { ownership: /* @__PURE__ */ new Map(), byGoal: /* @__PURE__ */ new Map(), warned: /* @__PURE__ */ new Set(), blocked: /* @__PURE__ */ new Set() };
    ledgers.set(agent, l);
    liveLedgers.add(l);
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
  const prices = config.prices.length > 0 ? config.prices : DEFAULT_PRICES;
  for (const e of prices) {
    if (e.inputPerMillion < 0 || e.outputPerMillion < 0 || e.cacheReadPerMillion < 0) {
      throw new Error(`[goal-budget] \u6A21\u578B ${e.model} \u7684\u5355\u4EF7\u4E0D\u80FD\u4E3A\u8D1F`);
    }
    if (!(e.peakMultiplier >= 1)) {
      throw new Error(`[goal-budget] \u6A21\u578B ${e.model} \u7684 peakMultiplier \u4E0D\u80FD\u5C0F\u4E8E 1\uFF08\u9AD8\u5CF0\u4EF7\u4E0D\u4F1A\u6BD4\u975E\u9AD8\u5CF0\u4FBF\u5B9C\uFF09\uFF0C\u5F97\u5230 ${e.peakMultiplier}`);
    }
    for (const day of e.holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error(`[goal-budget] \u6A21\u578B ${e.model} \u7684 holidays \u5E94\u4E3A YYYY-MM-DD\uFF0C\u5F97\u5230 ${day}`);
      }
    }
  }
  const unlimited = isUnlimited(profileBudget);
  const projectionHandle = ctx.sessionProjections.register(createGoalBudgetProjection(prices));
  void Promise.resolve(projectionHandle).catch((error) => {
    ctx.logger.warn(`[goal-budget] goalBudget \u6295\u5F71\u6CE8\u518C\u5931\u8D25\uFF0C\u5BA2\u6237\u7AEF\u5C06\u8BFB\u4E0D\u5230\u9884\u7B97\uFF1A${String(error)}`);
  });
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
  if (unlimited) return;
  ctx.on("agent/inbox/claimed", (payload) => {
    const src = payload.message?.source;
    if (src?.kind !== "goal" || typeof src.round !== "number") return;
    if (src.round <= 0) return;
    ledgerFor(payload.agent).ownership.set(payload.turn, {
      goalId: String(src.goalId),
      round: src.round,
      agent: payload.agent
    });
  });
  ctx.on("dispose", () => {
    liveLedgers.clear();
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
    for (const l of allLedgers()) {
      const own = l.ownership.get(turn);
      if (!own) continue;
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
      const route = routeBySession.get(session);
      const entry = findPriceByModel(prices, route?.model);
      if (entry === void 0) spend.unpricedTurns = (spend.unpricedTurns ?? 0) + 1;
      const next = addUsage(opened, data?.usage, entry === void 0 ? UNPRICED : pricingAt(entry, at), at);
      spend.rounds.set(own.round, next);
      if (!next.attributable) spend.unattributableTurns += 1;
      const { budget: effective } = resolveBudget(own.agent);
      evaluate(ctx, l, own.goalId, own.agent, effective, config.onExceed, config.warnAtRatio ?? 0);
      return;
    }
  });
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
function allLedgers() {
  return liveLedgers;
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
