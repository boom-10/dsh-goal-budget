// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/accounting.ts
function costOf(usage, p) {
  const M = 1e6;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cacheRead);
  return freshInput / M * p.inputPerMillion + cacheRead / M * p.cacheReadPerMillion + (usage.outputTokens + (usage.reasoningTokens ?? 0)) / M * p.outputPerMillion;
}
function addUsage(prev, usage, p) {
  if (usage === void 0) {
    return { ...prev, attributable: false };
  }
  return {
    turn: prev.turn,
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: prev.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: prev.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: prev.costUsd + costOf(usage, p),
    attributable: true
  };
}
function totalsOf(spend) {
  let tokens = 0;
  let costUsd = 0;
  for (const t of spend.rounds.values()) {
    tokens += t.inputTokens + t.outputTokens + t.reasoningTokens;
    costUsd += t.costUsd;
  }
  return { tokens, costUsd, rounds: spend.rounds.size };
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
  if (ratios.length === 0) return { exceeded: false, ratio: 0 };
  const worst = ratios.reduce((a, b) => b.ratio > a.ratio ? b : a);
  return worst.ratio >= 1 ? { exceeded: true, ratio: worst.ratio, kind: worst.kind, limit: worst.limit, used: worst.used } : { exceeded: false, ratio: worst.ratio };
}

// src/index.ts
var name = "dsh-goal-budget";
var inject = ["goals", "sessions", "agents"];
var Config = z.object({
  budget: z.object({
    /** 累计 token 上限（input+output+reasoning）。0 = 不限制。 */
    tokens: z.number().default(0),
    /** 累计费用上限（美元，按下面的单价估算）。0 = 不限制。 */
    costUsd: z.number().default(0)
  }).default({ tokens: 0, costUsd: 0 }),
  pricing: z.object({
    inputPerMillion: z.number().default(0.15),
    outputPerMillion: z.number().default(0.6),
    /** ★ 缓存命中单价，比未命中低约 50 倍（第 0004 节实测）。 */
    cacheReadPerMillion: z.number().default(3e-3)
  }).default({ inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 3e-3 }),
  /** 超预算时的动作。`block` 会调 ctx.goals.block() 并自动 disarm。 */
  onExceed: z.union([z.const("block"), z.const("warn")]).default("block"),
  /** 达到该比例时注入一次提醒（0–1）。0 = 不提醒。 */
  warnAtRatio: z.number().default(0.8)
});
var ledgers = /* @__PURE__ */ new WeakMap();
var liveLedgers = /* @__PURE__ */ new Set();
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
  const budget = config.budget ?? { tokens: 0, costUsd: 0 };
  const pricing = config.pricing ?? {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 3e-3
  };
  const unlimited = (budget.tokens ?? 0) <= 0 && (budget.costUsd ?? 0) <= 0;
  console.log(
    `[goal-budget] \u5DF2\u52A0\u8F7D \xB7 inject=[${inject.join(",")}] \xB7 ` + (unlimited ? "\u672A\u914D\u7F6E\u9884\u7B97\uFF0C\u7A7A\u8F6C\u4E2D\uFF08\u8BBE\u7F6E budget.tokens \u6216 budget.costUsd \u540E\u751F\u6548\uFF09" : `\u9884\u7B97 tokens=${budget.tokens ?? 0} costUsd=${budget.costUsd ?? 0} \xB7 \u8D85\u9650\u52A8\u4F5C=${config.onExceed}`)
  );
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
    if (event?.type !== "assistant/message") return;
    const data = event.data;
    const turn = data?.turn;
    if (typeof turn !== "number") return;
    for (const l of allLedgers()) {
      const own = l.ownership.get(turn);
      if (!own) continue;
      const spend = spendFor(l, own.goalId);
      const prev = spend.rounds.get(own.round) ?? emptyTurn(turn);
      const next = addUsage(prev, data?.usage, pricing);
      spend.rounds.set(own.round, next);
      if (!next.attributable) spend.unattributableTurns += 1;
      evaluate(ctx, l, own.goalId, own.agent, config);
      return;
    }
  });
}
function allLedgers() {
  return liveLedgers;
}
function evaluate(ctx, l, goalId, agent, config) {
  const spend = l.byGoal.get(goalId);
  if (!spend) return;
  const verdict = checkBudget(spend, config.budget ?? {});
  const warnAt = config.warnAtRatio ?? 0;
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
  const message = `Goal exceeded its configured ${verdict.kind} budget: ${verdict.used.toFixed(verdict.kind === "costUsd" ? 6 : 0)} / ${verdict.limit}` + (spend.unattributableTurns > 0 ? ` (${spend.unattributableTurns} turn(s) reported no usage and are not counted)` : "");
  if (config.onExceed === "warn") {
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
